/**
 * Validation for product create / edit / CSV import. Shared by the API
 * routes and the import preview so both reject the same rows. Pure and
 * unit-tested; no I/O.
 */

import { isCurrencyCode, parseAmountToMinor } from "./money";

/** Columns written to `products` (migration 039), minus tenancy/audit. */
export interface ProductWrite {
  name: string;
  sku: string | null;
  description: string | null;
  price_minor: number;
  currency: string;
  tax_rate: number;
  max_discount_pct: number;
  is_active: boolean;
}

export type ProductInputResult =
  | { ok: true; product: ProductWrite }
  | { ok: false; error: string };

export const MAX_NAME_LENGTH = 200;
export const MAX_SKU_LENGTH = 64;
export const MAX_DESCRIPTION_LENGTH = 2000;
export const MAX_IMPORT_ROWS = 1000;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

/** "18", "18%", 18 → 18. Null when not a 0–100 number with ≤ 2 decimals. */
export function parsePercent(value: unknown): number | null {
  const raw = text(value).replace(/%$/, "").trim();
  if (raw === "") return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null;
  const pct = Number(raw);
  return pct <= 100 ? pct : null;
}

/** "yes" / "true" / "1" / "active" → true; "no" / "false" / "0" → false. */
export function parseBoolean(value: unknown, fallback: boolean): boolean | null {
  if (typeof value === "boolean") return value;
  const raw = text(value).toLowerCase();
  if (raw === "") return fallback;
  if (["true", "yes", "y", "1", "active"].includes(raw)) return true;
  if (["false", "no", "n", "0", "inactive"].includes(raw)) return false;
  return null;
}

/**
 * Validate one product. `price` is a human amount in major units
 * ("2999.00"); it is converted to minor units with the product's
 * currency, defaulting to `defaultCurrency`.
 */
export function validateProductInput(
  input: Record<string, unknown>,
  defaultCurrency: string,
): ProductInputResult {
  const name = text(input.name);
  if (!name) return { ok: false, error: "Name is required." };
  if (name.length > MAX_NAME_LENGTH) {
    return { ok: false, error: `Name must be at most ${MAX_NAME_LENGTH} characters.` };
  }

  const sku = text(input.sku) || null;
  if (sku && sku.length > MAX_SKU_LENGTH) {
    return { ok: false, error: `SKU must be at most ${MAX_SKU_LENGTH} characters.` };
  }

  const description = text(input.description) || null;
  if (description && description.length > MAX_DESCRIPTION_LENGTH) {
    return {
      ok: false,
      error: `Description must be at most ${MAX_DESCRIPTION_LENGTH} characters.`,
    };
  }

  const currency = (text(input.currency) || defaultCurrency).toUpperCase();
  if (!isCurrencyCode(currency)) {
    return { ok: false, error: `"${currency}" is not a 3-letter currency code.` };
  }

  const priceText = text(input.price);
  if (!priceText) return { ok: false, error: "Price is required." };
  const price_minor = parseAmountToMinor(priceText, currency);
  if (price_minor === null) {
    return { ok: false, error: `"${priceText}" is not a valid ${currency} price.` };
  }

  const tax_rate = parsePercent(input.tax_rate);
  if (tax_rate === null) return { ok: false, error: "Tax rate must be a percentage from 0 to 100." };

  const max_discount_pct = parsePercent(input.max_discount_pct);
  if (max_discount_pct === null) {
    return { ok: false, error: "Max discount must be a percentage from 0 to 100." };
  }

  const is_active = parseBoolean(input.is_active ?? input.active, true);
  if (is_active === null) return { ok: false, error: "Active must be yes or no." };

  return {
    ok: true,
    product: { name, sku, description, price_minor, currency, tax_rate, max_discount_pct, is_active },
  };
}

// ------------------------------------------------------------------
// CSV
// ------------------------------------------------------------------

/** Header aliases → canonical field names accepted by validateProductInput. */
const HEADER_ALIASES: Record<string, string> = {
  name: "name",
  product: "name",
  title: "name",
  sku: "sku",
  code: "sku",
  description: "description",
  price: "price",
  amount: "price",
  currency: "currency",
  tax: "tax_rate",
  tax_rate: "tax_rate",
  gst: "tax_rate",
  max_discount: "max_discount_pct",
  max_discount_pct: "max_discount_pct",
  active: "is_active",
  is_active: "is_active",
};

export const PRODUCT_CSV_TEMPLATE =
  "name,sku,price,currency,tax_rate,max_discount_pct,active,description\n" +
  '3-month plan,PLAN-3M,2999,INR,18,10,yes,"Coaching for 3 months, weekly calls"\n';

/**
 * RFC 4180 CSV → rows of cells. Handles quoted commas, escaped quotes
 * ("") and line breaks inside quotes, which a split-on-newline parser
 * would corrupt.
 */
export function parseCsv(textInput: string): string[][] {
  const input = textInput.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (inQuotes) {
      if (char === '"' && input[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export interface ProductCsvRow {
  /** 1-based line in the file, counting the header as line 1. */
  line: number;
  result: ProductInputResult;
}

export type ProductCsvParse =
  | { ok: true; rows: ProductCsvRow[] }
  | { ok: false; error: string };

/** Parse and validate a product CSV. Requires `name` and `price` columns. */
export function parseProductCsv(csv: string, defaultCurrency: string): ProductCsvParse {
  const table = parseCsv(csv);
  if (table.length < 2) return { ok: false, error: "The file has no product rows." };

  const fields = table[0].map((h) => HEADER_ALIASES[h.trim().toLowerCase().replace(/\s+/g, "_")]);
  if (!fields.includes("name") || !fields.includes("price")) {
    return { ok: false, error: 'The header row must include "name" and "price" columns.' };
  }
  if (table.length - 1 > MAX_IMPORT_ROWS) {
    return { ok: false, error: `Import at most ${MAX_IMPORT_ROWS} products at a time.` };
  }

  const rows = table.slice(1).map((cells, index) => {
    const record: Record<string, unknown> = {};
    fields.forEach((field, col) => {
      if (field) record[field] = cells[col] ?? "";
    });
    return { line: index + 2, result: validateProductInput(record, defaultCurrency) };
  });

  // A SKU twice in one file would make the upsert ambiguous.
  const seen = new Map<string, number>();
  const checked = rows.map((row) => {
    if (!row.result.ok || !row.result.product.sku) return row;
    const key = row.result.product.sku.toLowerCase();
    const first = seen.get(key);
    if (first !== undefined) {
      return {
        line: row.line,
        result: { ok: false, error: `SKU repeats line ${first}.` } as ProductInputResult,
      };
    }
    seen.set(key, row.line);
    return row;
  });

  return { ok: true, rows: checked };
}
