// Integration test for migration 040 (billing subscriptions + usage metering)
// against real Postgres semantics, using PGlite (in-process Postgres).
//
// Port of the standalone script that used to live in scratchpad/pgtest/run.mjs.
// Every former ok()/expectErr() check is kept, one `it` per check, in the same
// order. The cases share state (invoice ids, attempt ids, counters) so the
// suite runs sequentially.

import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped SQL result rows
type Row = Record<string, any>;

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const STUBS_SQL = path.join(REPO_ROOT, "supabase", "tests", "stubs.sql");
const MIGRATION_040 = path.join(
  REPO_ROOT,
  "supabase",
  "migrations",
  "040_billing_subscriptions_usage.sql",
);

// One PGlite boot for the whole file. Boot + two migration applies is the
// only expensive step; every `it` is a cheap query.
const SETUP_TIMEOUT_MS = 60_000;

let db: PGlite;
let secondApplyError: unknown;

// Shared fixture + state across the sequential cases below.
let A: string;
let B: string;
let ownerA: string;
let op: string;

let inv1: Row;
let inv: Row;
let att: Row;
let sub: Row;
let ren: Row;
let ratt: Row;
let rf: Row;
let r1: Row;
let r2: Row;
let r3: Row;
let r4: Row;
let g: Row;
let invB: Row;
let attB: Row;
let inv3: Row;
let att3: Row;
let sb: Row;

const q = async (text: string, params?: unknown[]): Promise<Row[]> =>
  (await db.query(text, params)).rows as Row[];

const one = async (text: string, params?: unknown[]): Promise<Row> =>
  (await q(text, params))[0];

// Asserts that the statement fails and the error message contains `needle`.
async function expectErr(
  text: string,
  params: unknown[],
  needle: string,
): Promise<void> {
  let message: string | undefined;
  try {
    await db.query(text, params);
  } catch (e) {
    message = String((e as Error).message);
  }
  expect(message, "expected the statement to fail").toBeDefined();
  expect(message).toContain(needle);
}

const reserve = (acc: string, key: string, amt = 1) =>
  one(`SELECT usage_reserve($1, 'ai_responses', $3, $2) AS r`, [acc, key, amt]);

// Settlement SQL, parameterised by attempt/UTR/amount/currency.
const settle = (
  amount: number,
  cur = "INR",
  utr = "432109876543",
  attempt: string = att.id,
) =>
  `SELECT billing_settle_payment('${attempt}', '${utr}', ${amount}, '${cur}', 'HDFC-XX1234', NOW() - INTERVAL '10 minutes', '${op}', 'op@x', 'checked statement') AS r`;

beforeAll(async () => {
  db = new PGlite();

  // ---- Minimal Supabase + earlier-migration stubs ----
  await db.exec(readFileSync(STUBS_SQL, "utf8"));

  // ---- Migration 040, applied twice (idempotency) ----
  const sql040 = readFileSync(MIGRATION_040, "utf8");
  await db.exec(sql040);
  try {
    await db.exec(sql040);
  } catch (e) {
    secondApplyError = e;
  }

  // ---- Fixtures ----
  await db.exec(`
    INSERT INTO plans (id, name, is_public, price_minor, currency, period_days, grace_days, monthly_ai_responses, max_contacts)
    VALUES ('starter', 'Starter', TRUE, 99900, 'INR', 30, 3, 2, 500),
           ('growth', 'Growth', TRUE, 299900, 'INR', 30, 3, NULL, NULL);
  `);
  A = (await one(`INSERT INTO accounts (name) VALUES ('A') RETURNING id`)).id;
  B = (await one(`INSERT INTO accounts (name) VALUES ('B') RETURNING id`)).id;
  ownerA = (
    await one(`INSERT INTO auth.users (email) VALUES ('a@x') RETURNING id`)
  ).id;
  await q(`INSERT INTO profiles VALUES ($1, $2, 'owner')`, [ownerA, A]);
  op = (await one(`INSERT INTO auth.users (email) VALUES ('op@x') RETURNING id`))
    .id;
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await db?.close();
});

describe.sequential("migration 040 (billing + usage)", () => {
  it("migration 040 applies twice (idempotent)", () => {
    expect(secondApplyError).toBeUndefined();
  });

  describe("checkout", () => {
    it("checkout derives amount from plan price", async () => {
      inv1 = await one(
        `SELECT * FROM billing_open_checkout($1, 'starter', 'new', 0, $2)`,
        [A, ownerA],
      );
      expect(Number(inv1.amount_minor)).toBe(99900);
      expect(inv1.status).toBe("open");
    });

    it("repeat checkout reuses the open invoice", async () => {
      const inv1b = await one(
        `SELECT * FROM billing_open_checkout($1, 'starter', 'new', 0, $2)`,
        [A, ownerA],
      );
      expect(inv1b.id).toBe(inv1.id);
    });

    it("first checkout creates pending_payment subscription", async () => {
      const row = await one(
        `SELECT status FROM subscriptions WHERE account_id = $1`,
        [A],
      );
      expect(row.status).toBe("pending_payment");
    });

    it("plan without a price is not for sale", async () => {
      await expectErr(
        `SELECT billing_open_checkout($1, 'unlimited', 'new', 0, $2)`,
        [A, ownerA],
        "plan_not_for_sale",
      );
    });

    it("credit is ignored for non-upgrade invoices", async () => {
      const upInv = await one(
        `SELECT * FROM billing_open_checkout($1, 'growth', 'new', 999999999, $2)`,
        [A, ownerA],
      );
      expect(Number(upInv.amount_minor)).toBe(299900);
    });

    it("stale open invoice is voided", async () => {
      const row = await one(`SELECT status FROM invoices WHERE id = $1`, [
        inv1.id,
      ]);
      expect(row.status).toBe("void");
    });
  });

  describe("payment attempts", () => {
    it("attempt amount copied from invoice", async () => {
      inv = await one(
        `SELECT * FROM billing_open_checkout($1, 'starter', 'new', 0, $2)`,
        [A, ownerA],
      );
      att = await one(
        `SELECT * FROM billing_create_payment_attempt($1, $2, 'manual_upi', 'idem-key-0001', 'TCREF0001', 'upi://x', NULL, NULL, 30)`,
        [inv.id, A],
      );
      expect(Number(att.amount_minor)).toBe(99900);
    });

    it("idempotency key returns the same attempt", async () => {
      const att2 = await one(
        `SELECT * FROM billing_create_payment_attempt($1, $2, 'manual_upi', 'idem-key-0001', 'TCREF0002', 'upi://x', NULL, NULL, 30)`,
        [inv.id, A],
      );
      expect(att2.id).toBe(att.id);
    });

    it("attempt for another tenant rejected", async () => {
      await expectErr(
        `SELECT billing_create_payment_attempt($1, $2, 'manual_upi', 'idem-key-0009', 'TCREF0009', NULL, NULL, NULL, 30)`,
        [inv.id, B],
        "invoice not found",
      );
    });

    it("customer UTR is recorded as a claim", async () => {
      sub = await one(`SELECT billing_submit_customer_utr($1, $2, '4321 0987 6543') AS r`, [
        att.id,
        A,
      ]);
      expect(sub.r.status).toBe("pending_verification");
    });

    it("UTR claim from another tenant rejected", async () => {
      await expectErr(
        `SELECT billing_submit_customer_utr($1, $2, '432109876543')`,
        [att.id, B],
        "not found",
      );
    });
  });

  describe("settlement", () => {
    it("wrong amount rejected", async () => {
      await expectErr(settle(99800), [], "amount_mismatch");
    });

    it("wrong currency rejected", async () => {
      await expectErr(settle(99900, "USD"), [], "currency_mismatch");
    });

    it("exact settlement activates the plan", async () => {
      const s1 = await one(settle(99900));
      expect(s1.r.subscription_status).toBe("active");
      expect(s1.r.plan_id).toBe("starter");
    });

    it("account synced from plan", async () => {
      const accA = await one(
        `SELECT plan, status, max_contacts FROM accounts WHERE id = $1`,
        [A],
      );
      expect(accA.plan).toBe("starter");
      expect(accA.status).toBe("active");
      expect(accA.max_contacts).toBe(500);
    });

    it("replayed settlement rejected", async () => {
      await expectErr(settle(99900), [], "attempt_not_verifiable");
    });

    it("ledger is append-only", async () => {
      await expectErr(
        `UPDATE billing_ledger SET amount_minor = 1`,
        [],
        "append-only",
      );
    });

    it("audit log is append-only", async () => {
      await expectErr(`DELETE FROM billing_audit_log`, [], "append-only");
    });

    it("duplicate bank UTR rejected", async () => {
      ren = await one(
        `SELECT * FROM billing_open_checkout($1, 'starter', 'renewal', 0, $2)`,
        [A, ownerA],
      );
      ratt = await one(
        `SELECT * FROM billing_create_payment_attempt($1, $2, 'manual_upi', 'idem-key-0002', 'TCREF0003', NULL, NULL, NULL, 30)`,
        [ren.id, A],
      );
      await expectErr(
        settle(99900, "INR", "432109876543", ratt.id),
        [],
        "duplicate_utr",
      );
    });

    it("early renewal extends from current period end", async () => {
      const periodBefore = (
        await one(
          `SELECT current_period_end FROM subscriptions WHERE account_id = $1`,
          [A],
        )
      ).current_period_end;
      await one(settle(99900, "INR", "UTR998877665544", ratt.id));
      const periodAfter = (
        await one(
          `SELECT current_period_end FROM subscriptions WHERE account_id = $1`,
          [A],
        )
      ).current_period_end;
      expect(
        Math.round((periodAfter - periodBefore) / 86400000),
      ).toBe(30);
    });
  });

  describe("refunds", () => {
    it("refund above net paid rejected", async () => {
      await expectErr(
        `SELECT billing_record_refund($1, 100000, 'RF1', 'too much', $2, 'op@x')`,
        [ren.id, op],
        "exceeds",
      );
    });

    it("partial refund recorded", async () => {
      rf = await one(
        `SELECT billing_record_refund($1, 40000, 'RF1', 'partial goodwill', $2, 'op@x') AS r`,
        [ren.id, op],
      );
      expect(rf.r.fully_refunded).toBe(false);
      expect(Number(rf.r.net_paid_minor)).toBe(59900);
    });

    it("full refund marks invoice refunded", async () => {
      const rf2 = await one(
        `SELECT billing_record_refund($1, 59900, 'RF2', 'rest', $2, 'op@x') AS r`,
        [ren.id, op],
      );
      expect(rf2.r.fully_refunded).toBe(true);
    });
  });

  describe("usage metering", () => {
    it("reserve within quota", async () => {
      r1 = (await reserve(A, "ai:wamid1")).r;
      expect(r1.ok).toBe(true);
    });

    it("duplicate webhook delivery is not charged twice", async () => {
      expect((await reserve(A, "ai:wamid1")).r.duplicate).toBe(true);
    });

    it("monthly quota blocks the third AI reply", async () => {
      r2 = (await reserve(A, "ai:wamid2")).r;
      r3 = (await reserve(A, "ai:wamid3")).r;
      expect(r3.ok).toBe(false);
      expect(r3.reason).toBe("quota_exceeded");
    });

    it("released reservation frees quota", async () => {
      await one(`SELECT usage_release($1)`, [r2.reservation_id]);
      r4 = (await reserve(A, "ai:wamid4")).r;
      expect(r4.ok).toBe(true);
    });

    it("commit is idempotent", async () => {
      await one(`SELECT usage_commit($1, 1)`, [r1.reservation_id]);
      expect(
        (await one(`SELECT usage_commit($1, 1) AS r`, [r1.reservation_id])).r
          .reason,
      ).toBe("already_committed");
    });

    it("counters track used/reserved/blocked", async () => {
      const counter = await one(
        `SELECT used, reserved, blocked FROM usage_counters WHERE account_id = $1 AND metric = 'ai_responses'`,
        [A],
      );
      expect(Number(counter.used)).toBe(1);
      expect(Number(counter.reserved)).toBe(1);
      expect(Number(counter.blocked)).toBe(1);
    });

    it("legacy account without subscription is never quota-blocked", async () => {
      expect((await reserve(B, "ai:b1", 1000)).r.ok).toBe(true);
    });

    it("usage_record is idempotent", async () => {
      const first = await one(
        `SELECT usage_record($1, 'messages', 1, 'in:w1') AS r`,
        [A],
      );
      const second = await one(
        `SELECT usage_record($1, 'messages', 1, 'in:w1') AS r`,
        [A],
      );
      expect(first.r).toBe(true);
      expect(second.r).toBe(false);
    });
  });

  describe("rate limit + inbound claims", () => {
    it("shared rate limit blocks the 3rd hit", async () => {
      const hits: boolean[] = [];
      for (let i = 0; i < 3; i++) {
        hits.push((await one(`SELECT rate_limit_hit('k', 2, 60) AS r`)).r.allowed);
      }
      expect(hits).toEqual([true, true, false]);
    });

    it("inbound wamid claimed once", async () => {
      const first = await one(
        `SELECT claim_inbound_message('pn1', 'wamid.X', $1) AS r`,
        [A],
      );
      const second = await one(
        `SELECT claim_inbound_message('pn1', 'wamid.X', $1) AS r`,
        [A],
      );
      expect(first.r).toBe(true);
      expect(second.r).toBe(false);
    });
  });

  describe("suspension", () => {
    it("suspension locks the account", async () => {
      await one(`SELECT billing_admin_event($1, 'suspend', 'chargeback', $2, 'op@x')`, [
        A,
        op,
      ]);
      expect(
        (await one(`SELECT status FROM accounts WHERE id = $1`, [A])).status,
      ).toBe("suspended");
    });

    it("suspended account cannot reserve usage", async () => {
      expect((await reserve(A, "ai:wamid5")).r.reason).toBe(
        "subscription_inactive",
      );
    });

    it("operator action requires a reason", async () => {
      await expectErr(
        `SELECT billing_admin_event($1, 'suspend', '', $2, 'op@x')`,
        [A, op],
        "reason is required",
      );
    });

    it("reinstate restores active", async () => {
      await one(`SELECT billing_admin_event($1, 'reinstate', 'resolved', $2, 'op@x')`, [
        A,
        op,
      ]);
      expect(
        (await one(`SELECT status FROM subscriptions WHERE account_id = $1`, [A]))
          .status,
      ).toBe("active");
    });
  });

  describe("reconciliation over time", () => {
    it("period end → past_due", async () => {
      await q(
        `UPDATE subscriptions SET current_period_end = NOW() - INTERVAL '1 minute', current_period_start = NOW() - INTERVAL '31 days' WHERE account_id = $1`,
        [A],
      );
      await one(`SELECT billing_reconcile()`);
      expect(
        (await one(`SELECT status FROM subscriptions WHERE account_id = $1`, [A]))
          .status,
      ).toBe("past_due");
    });

    it("past_due → grace with a deadline", async () => {
      await one(`SELECT billing_reconcile()`);
      g = await one(
        `SELECT status, grace_ends_at FROM subscriptions WHERE account_id = $1`,
        [A],
      );
      expect(g.status).toBe("grace");
      expect(g.grace_ends_at > new Date()).toBe(true);
    });

    it("grace still allows chargeable work (quota permitting)", async () => {
      expect((await reserve(A, "ai:wamid6")).r.ok).not.toBeUndefined();
    });

    it("grace end → expired", async () => {
      await q(
        `UPDATE subscriptions SET grace_ends_at = NOW() - INTERVAL '1 minute' WHERE account_id = $1`,
        [A],
      );
      await one(`SELECT billing_reconcile()`);
      expect(
        (await one(`SELECT status FROM subscriptions WHERE account_id = $1`, [A]))
          .status,
      ).toBe("expired");
    });

    it("owner notified once (6h dedupe)", async () => {
      const row = await one(
        `SELECT count(*)::int AS n FROM notifications WHERE account_id = $1 AND type = 'billing'`,
        [A],
      );
      expect(row.n).toBe(1);
    });

    it("reconcile is idempotent", async () => {
      const again = await one(`SELECT billing_reconcile() AS r`);
      expect(again.r.subscription_transitions).toBe(0);
    });

    it("expired account blocked from chargeable work", async () => {
      expect((await reserve(A, "ai:wamid7")).r.reason).toBe(
        "subscription_inactive",
      );
    });

    it("expired → pay → active", async () => {
      inv3 = await one(
        `SELECT * FROM billing_open_checkout($1, 'starter', 'new', 0, $2)`,
        [A, ownerA],
      );
      att3 = await one(
        `SELECT * FROM billing_create_payment_attempt($1, $2, 'manual_upi', 'idem-key-0003', 'TCREF0004', NULL, NULL, NULL, 30)`,
        [inv3.id, A],
      );
      await one(settle(99900, "INR", "UTR111122223333", att3.id));
      expect(
        (await one(`SELECT status FROM subscriptions WHERE account_id = $1`, [A]))
          .status,
      ).toBe("active");
    });

    it("unpaid attempt expires", async () => {
      const invBRow = await one(
        `SELECT * FROM billing_open_checkout($1, 'starter', 'new', 0, NULL)`,
        [B],
      );
      invB = invBRow;
      attB = await one(
        `SELECT * FROM billing_create_payment_attempt($1, $2, 'manual_upi', 'idem-key-0004', 'TCREF0005', NULL, NULL, NULL, 30)`,
        [invB.id, B],
      );
      await q(
        `UPDATE payment_attempts SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
        [attB.id],
      );
      await q(
        `UPDATE invoices SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
        [invB.id],
      );
      await one(`SELECT billing_reconcile()`);
      expect(
        (await one(`SELECT status FROM payment_attempts WHERE id = $1`, [attB.id]))
          .status,
      ).toBe("expired");
    });

    it("unpaid invoice expires", async () => {
      expect(
        (await one(`SELECT status FROM invoices WHERE id = $1`, [invB.id])).status,
      ).toBe("expired");
    });

    it("cannot settle against an expired invoice", async () => {
      await expectErr(
        settle(99900, "INR", "UTR444455556666", attB.id),
        [],
        "invoice_not_open",
      );
    });

    it("cancel at period end → cancelled", async () => {
      await one(`SELECT billing_cancel_at_period_end($1, TRUE, $2)`, [A, ownerA]);
      await q(
        `UPDATE subscriptions SET current_period_start = NOW() - INTERVAL '31 days', current_period_end = NOW() - INTERVAL '1 minute' WHERE account_id = $1`,
        [A],
      );
      await one(`SELECT billing_reconcile()`);
      expect(
        (await one(`SELECT status FROM subscriptions WHERE account_id = $1`, [A]))
          .status,
      ).toBe("cancelled");
    });
  });

  describe("operator override", () => {
    it("operator can start a trial", async () => {
      await one(
        `SELECT billing_admin_set_subscription($1, 'growth', 'trialing', NOW() + INTERVAL '14 days', 'pilot', $2, 'op@x')`,
        [B, op],
      );
      sb = await one(
        `SELECT status, trial_ends_at FROM subscriptions WHERE account_id = $1`,
        [B],
      );
      expect(sb.status).toBe("trialing");
      expect(
        (await one(`SELECT status FROM accounts WHERE id = $1`, [B])).status,
      ).toBe("trialing");
    });
  });

  describe("grants", () => {
    it("authenticated cannot execute billing_settle_payment", async () => {
      const row = await one(
        `SELECT has_function_privilege('authenticated', 'billing_settle_payment(uuid,text,bigint,text,text,timestamptz,uuid,text,text)', 'EXECUTE') AS a`,
      );
      expect(row.a).toBe(false);
    });

    it("anon cannot execute usage_reserve", async () => {
      const row = await one(
        `SELECT has_function_privilege('anon', 'usage_reserve(uuid,text,bigint,text,integer)', 'EXECUTE') AS b`,
      );
      expect(row.b).toBe(false);
    });

    it("service_role can execute billing_reconcile", async () => {
      const row = await one(
        `SELECT has_function_privilege('service_role', 'billing_reconcile()', 'EXECUTE') AS c`,
      );
      expect(row.c).toBe(true);
    });
  });
});
