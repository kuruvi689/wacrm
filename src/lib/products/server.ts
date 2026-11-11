import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import { DEFAULT_CURRENCY } from "@/lib/currency";
import { isCurrencyCode } from "./money";

// Server-only helpers shared by the products and orders routes.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** The account's default currency (migration 021), used when a row omits one. */
export async function accountDefaultCurrency(accountId: string): Promise<string> {
  const { data } = await supabaseAdmin()
    .from("accounts")
    .select("default_currency")
    .eq("id", accountId)
    .maybeSingle();
  const code = data?.default_currency;
  return isCurrencyCode(code) ? code : DEFAULT_CURRENCY;
}

/** Map a Postgres/PostgREST error to a response without leaking internals. */
export function dbErrorResponse(
  error: { code?: string; message: string },
  context: string,
): NextResponse {
  if (error.code === "23505") {
    return NextResponse.json(
      { error: "Another product already uses this SKU." },
      { status: 409 },
    );
  }
  if (error.code === "23514") {
    return NextResponse.json({ error: "Some values are out of range." }, { status: 400 });
  }
  console.error(`[${context}]`, error.message);
  return NextResponse.json({ error: "Database error" }, { status: 500 });
}
