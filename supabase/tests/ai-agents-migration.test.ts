// Migration 044 (AI agents) against real Postgres semantics via PGlite:
// immutable versions, append-only events, one active agent per account,
// atomic activation, rollback pointer, tenant guards and the backfill.

import { PGlite } from "@electric-sql/pglite";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";
import { vector } from "@electric-sql/pglite/vector";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped SQL rows
type Row = Record<string, any>;

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const files = readdirSync(DIR).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();

const STUBS = `
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

let db: PGlite;
let A: string;
let B: string;
let user: string;
let agent1: string;
let agent2: string;
let v1: string;
let v2: string;
let backfillAccount: string;

const q = async (text: string, params?: unknown[]): Promise<Row[]> => (await db.query(text, params)).rows as Row[];
const one = async (text: string, params?: unknown[]) => (await q(text, params))[0];

async function expectErr(text: string, params: unknown[], needle: string) {
  let message: string | undefined;
  try {
    await db.query(text, params);
  } catch (e) {
    message = String((e as Error).message);
  }
  expect(message, "expected the statement to fail").toBeDefined();
  expect(message).toContain(needle);
}

// accounts are one-per-owner, so each gets its own owner user.
const mkAccount = async (name: string): Promise<string> => {
  const u = (await one(`INSERT INTO auth.users (email) VALUES ($1) RETURNING id`, [`${name}@x`])).id;
  // The signup trigger usually creates the owner's account already.
  const existing = await one(`SELECT id FROM accounts WHERE owner_user_id = $1`, [u]);
  if (existing) return existing.id;
  return (await one(`INSERT INTO accounts (name, owner_user_id) VALUES ($1, $2) RETURNING id`, [name, u])).id;
};

const newVersion = (agent: string, account: string, n: number) =>
  one(
    `INSERT INTO ai_agent_versions (agent_id, account_id, version_number, provider, model)
     VALUES ($1, $2, $3, 'openai', 'gpt-x') RETURNING id`,
    [agent, account, n],
  );

beforeAll(async () => {
  db = new PGlite({ extensions: { vector, uuid_ossp } });
  await db.exec(STUBS);
  for (const f of files.filter((x) => x < "044")) await db.exec(readFileSync(path.join(DIR, f), "utf8"));

  // Pre-044 state: one account with the legacy AI config (active + auto-reply)
  // and one with a disabled config, to exercise the backfill.
  user = (await one(`INSERT INTO auth.users (email) VALUES ('u@x') RETURNING id`)).id;
  backfillAccount = await mkAccount('Legacy');
  const offAccount = await mkAccount('Off');
  await q(
    `INSERT INTO ai_configs (account_id, provider, model, api_key, system_prompt, is_active, auto_reply_enabled)
     VALUES ($1, 'anthropic', 'claude-haiku', 'enc', 'Be nice', true, true),
            ($2, 'openai', 'gpt-x', 'enc', NULL, true, false)`,
    [backfillAccount, offAccount],
  );

  const sql = readFileSync(path.join(DIR, "044_ai_agents.sql"), "utf8");
  await db.exec(sql);
  await db.exec(sql); // idempotent re-apply (also must not duplicate the backfill)

  A = await mkAccount('A');
  B = await mkAccount('B');
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe.sequential("migration 044", () => {
  it("backfills one agent + version 1 per config; active only when auto-reply was on; not duplicated", async () => {
    const rows = await q(`SELECT a.status, a.current_version_id, v.version_number, v.provider, v.system_prompt
        FROM ai_agents a JOIN ai_agent_versions v ON v.id = a.current_version_id
        WHERE a.account_id = ANY(SELECT account_id FROM ai_configs) ORDER BY a.status`);
    expect(rows.map((r) => r.status)).toEqual(["active", "draft"]);
    expect(rows.every((r) => r.version_number === 1)).toBe(true);
    expect(rows.find((r) => r.status === "active")).toMatchObject({ provider: "anthropic", system_prompt: "Be nice" });
  });

  it("creates agents, versions and the current-version pointer", async () => {
    agent1 = (await one(`INSERT INTO ai_agents (account_id, name) VALUES ($1, 'One') RETURNING id`, [A])).id;
    agent2 = (await one(`INSERT INTO ai_agents (account_id, name) VALUES ($1, 'Two') RETURNING id`, [A])).id;
    v1 = (await newVersion(agent1, A, 1)).id;
    v2 = (await newVersion(agent1, A, 2)).id;
    await q(`UPDATE ai_agents SET current_version_id = $1 WHERE id = $2`, [v2, agent1]);
    expect((await one(`SELECT current_version_id FROM ai_agents WHERE id = $1`, [agent1])).current_version_id).toBe(v2);
  });

  it("versions are immutable: UPDATE and DELETE are refused", async () => {
    await expectErr(`UPDATE ai_agent_versions SET model = 'hacked' WHERE id = $1`, [v1], "immutable");
    await expectErr(`DELETE FROM ai_agent_versions WHERE id = $1`, [v1], "immutable");
    expect((await one(`SELECT model FROM ai_agent_versions WHERE id = $1`, [v1])).model).toBe("gpt-x");
  });

  it("version numbers are unique per agent and bounds are enforced", async () => {
    await expectErr(
      `INSERT INTO ai_agent_versions (agent_id, account_id, version_number, provider, model) VALUES ($1, $2, 1, 'openai', 'm')`,
      [agent1, A],
      "duplicate key",
    );
    for (const col of ["temperature = 2.5", "max_output_tokens = 63", "max_output_tokens = 4097", "context_message_limit = 0", "context_message_limit = 51"]) {
      const [name, val] = col.split(" = ");
      await expect(
        db.query(
          `INSERT INTO ai_agent_versions (agent_id, account_id, version_number, provider, model, ${name}) VALUES ($1, $2, 99, 'openai', 'm', ${val})`,
          [agent2, A],
        ),
      ).rejects.toThrow();
    }
    await expect(
      db.query(`INSERT INTO ai_agent_versions (agent_id, account_id, version_number, provider, model, n8n_webhook_url) VALUES ($1,$2,98,'openai','m','http://x.example.com')`, [agent2, A]),
    ).rejects.toThrow();
  });

  it("a version must carry its agent's account (tenant guard)", async () => {
    await expectErr(
      `INSERT INTO ai_agent_versions (agent_id, account_id, version_number, provider, model) VALUES ($1, $2, 50, 'openai', 'm')`,
      [agent1, B],
      "must match the agent account",
    );
  });

  it("current_version_id must belong to the same agent", async () => {
    const foreign = (await newVersion(agent2, A, 1)).id;
    await expectErr(`UPDATE ai_agents SET current_version_id = $1 WHERE id = $2`, [foreign, agent1], "version of this agent");
  });

  it("rollback is just moving the pointer to an older version; history stays", async () => {
    await q(`UPDATE ai_agents SET current_version_id = $1 WHERE id = $2`, [v1, agent1]);
    await q(`INSERT INTO ai_agent_events (agent_id, account_id, event, from_version_id, to_version_id, actor_user_id) VALUES ($1,$2,'rollback',$3,$4,$5)`, [agent1, A, v2, v1, user]);
    expect((await one(`SELECT count(*)::int AS n FROM ai_agent_versions WHERE agent_id = $1`, [agent1])).n).toBe(2);
  });

  it("events are append-only", async () => {
    await expectErr(`UPDATE ai_agent_events SET event = 'created' WHERE agent_id = $1`, [agent1], "append-only");
    await expectErr(`DELETE FROM ai_agent_events WHERE agent_id = $1`, [agent1], "append-only");
  });

  it("allows at most one ACTIVE agent per account; activation swaps atomically", async () => {
    await q(`UPDATE ai_agents SET status = 'active' WHERE id = $1`, [agent1]);
    await expectErr(`UPDATE ai_agents SET status = 'active' WHERE id = $1`, [agent2], "uq_ai_agents_one_active");
    await q(`UPDATE ai_agents SET current_version_id = (SELECT id FROM ai_agent_versions WHERE agent_id = $1 LIMIT 1) WHERE id = $1`, [agent2]);
    expect((await one(`SELECT ai_agent_activate($1, $2) AS ok`, [agent2, A])).ok).toBe(true);
    const s = await q(`SELECT id, status FROM ai_agents WHERE account_id = $1 AND id IN ($2, $3)`, [A, agent1, agent2]);
    expect(s.find((r) => r.id === agent2)?.status).toBe("active");
    expect(s.find((r) => r.id === agent1)?.status).toBe("paused");
  });

  it("activation refuses an agent of another account or without a version", async () => {
    expect((await one(`SELECT ai_agent_activate($1, $2) AS ok`, [agent2, B])).ok).toBe(false);
    const empty = (await one(`INSERT INTO ai_agents (account_id, name) VALUES ($1, 'Empty') RETURNING id`, [A])).id;
    expect((await one(`SELECT ai_agent_activate($1, $2) AS ok`, [empty, A])).ok).toBe(false);
  });

  it("deleting an account still cascades through versions and events", async () => {
    await q(`DELETE FROM accounts WHERE id = $1`, [A]);
    expect((await one(`SELECT count(*)::int AS n FROM ai_agent_versions WHERE account_id = $1`, [A])).n).toBe(0);
    expect((await one(`SELECT count(*)::int AS n FROM ai_agent_events WHERE account_id = $1`, [A])).n).toBe(0);
  });

  it("ai_usage_log gains the metering columns", async () => {
    const cols = (await q(`SELECT column_name FROM information_schema.columns WHERE table_name = 'ai_usage_log'`)).map((c) => c.column_name);
    for (const c of ["agent_id", "agent_version_id", "latency_ms", "status", "error_code", "estimated_cost_micros", "source"]) {
      expect(cols).toContain(c);
    }
  });
});
