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

it("requires demo opt-in and seeds an isolated workspace twice without duplicates", async () => {
  const seed = readFileSync(path.join(MIGRATIONS_DIR, "..", "seed", "demo.sql"), "utf8");

  await expect(db.exec(seed)).rejects.toThrow("isolated-staging opt-in");
  await db.exec("SET wacrm.demo_seed = 'isolated-staging'");
  await expect(db.exec(seed)).rejects.toThrow("query returned no rows");
  await db.exec("INSERT INTO auth.users (email) VALUES ('wacrm-demo@example.invalid')");

  await db.exec(seed);
  await db.exec(seed);

  const result = await db.query(`
    SELECT
      (SELECT count(*)::int FROM contacts) AS contacts,
      (SELECT count(*)::int FROM conversations) AS conversations,
      (SELECT count(*)::int FROM messages) AS messages,
      (SELECT count(*)::int FROM ai_agents WHERE status = 'draft' AND current_version_id IS NOT NULL) AS agents,
      (SELECT count(*)::int FROM plans WHERE id = 'wacrm-demo' AND NOT is_public AND price_minor IS NULL) AS demo_plans
  `);
  expect(result.rows).toEqual([{ contacts: 1, conversations: 1, messages: 1, agents: 1, demo_plans: 1 }]);
});


it("limits CRM reads to the authenticated user's workspace", async () => {
  await db.exec(`
    INSERT INTO auth.users (id, email) VALUES
      ('0d3a0000-0000-4000-8000-000000000011', 'owner-a@example.invalid'),
      ('0d3a0000-0000-4000-8000-000000000012', 'owner-b@example.invalid');
    INSERT INTO contacts (user_id, account_id, phone, name)
    SELECT owner_user_id, id, '12025550142', name
    FROM accounts
    WHERE owner_user_id IN (
      '0d3a0000-0000-4000-8000-000000000011',
      '0d3a0000-0000-4000-8000-000000000012'
    );
    -- Mirror the API role's schema and table grants for this policy test.
    GRANT USAGE ON SCHEMA auth, public TO authenticated;
    GRANT SELECT ON contacts, conversations, ai_agents, plans TO authenticated;
  `);

  await db.transaction(async (tx) => {
    await tx.exec(`
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '0d3a0000-0000-4000-8000-000000000011';
      SET LOCAL request.jwt.claim.role = 'authenticated';
    `);
    const own = await tx.query("SELECT name FROM contacts");
    expect(own.rows).toEqual([{ name: "owner-a@example.invalid" }]);
    const otherConversations = await tx.query("SELECT id FROM conversations");
    expect(otherConversations.rows).toEqual([]);
    const otherAgents = await tx.query("SELECT id FROM ai_agents");
    expect(otherAgents.rows).toEqual([]);
    const privatePlan = await tx.query("SELECT id FROM plans WHERE id = 'wacrm-demo'");
    expect(privatePlan.rows).toEqual([]);
  });
});
