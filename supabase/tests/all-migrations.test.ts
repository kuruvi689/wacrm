// Every migration must apply in order on a fresh Postgres, and every
// migration from 039 on must be safe to re-run (they are written to be
// idempotent, and operators re-run them when a deploy is retried).
//
// Uses PGlite (in-process Postgres) with the few Supabase objects the
// migrations reference (auth schema, storage tables, roles, the
// supabase_realtime publication). pgvector and uuid-ossp are real
// PGlite extensions.

import { PGlite } from "@electric-sql/pglite";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";
import { vector } from "@electric-sql/pglite/vector";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);
const RERUN_FROM = "039";

const SUPABASE_STUBS = `
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE supabase_auth_admin;
  CREATE SCHEMA auth; CREATE SCHEMA storage; CREATE SCHEMA extensions;
  CREATE TABLE auth.users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email TEXT,
    raw_user_meta_data JSONB DEFAULT '{}'::jsonb, email_confirmed_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW());
  CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE
    AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  CREATE FUNCTION auth.role() RETURNS TEXT LANGUAGE sql STABLE
    AS $$ SELECT current_setting('request.jwt.claim.role', true) $$;
  CREATE FUNCTION auth.jwt() RETURNS JSONB LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
  CREATE TABLE storage.buckets (id TEXT PRIMARY KEY, name TEXT, public BOOLEAN, file_size_limit BIGINT,
    allowed_mime_types TEXT[], created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
  CREATE TABLE storage.objects (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id TEXT, name TEXT,
    owner UUID, metadata JSONB, created_at TIMESTAMPTZ DEFAULT NOW());
  ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
  CREATE FUNCTION storage.foldername(name TEXT) RETURNS TEXT[] LANGUAGE sql IMMUTABLE
    AS $$ SELECT string_to_array(name, '/') $$;
  CREATE PUBLICATION supabase_realtime;
`;

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d{3}_.*\.sql$/.test(f))
  .sort();

let db: PGlite;

beforeAll(async () => {
  db = new PGlite({ extensions: { vector, uuid_ossp } });
  await db.exec(SUPABASE_STUBS);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe.sequential("migrations apply in order on a fresh database", () => {
  it.each(files)("%s", async (file) => {
    await expect(db.exec(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"))).resolves.toBeDefined();
  });
});

describe.sequential(`migrations from ${RERUN_FROM} are idempotent`, () => {
  it.each(files.filter((f) => f >= RERUN_FROM))("%s re-applies cleanly", async (file) => {
    await expect(db.exec(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"))).resolves.toBeDefined();
  });
});
