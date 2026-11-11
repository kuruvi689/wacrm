/**
 * Order pricing — the ONLY place an order total is computed. Callers
 * (agent UI today, the AI's `create_order` tool later) pass product
 * ids and quantities; prices, tax and discount limits come from the
 * product rows. Pure and unit-tested; no I/O.
 */

import { percentOf } from "./money";

export interface PricingProduct {
  id: string;
  name: string;
  sku: string | null;
  price_minor: number;
  currency: string;
  tax_rate: number;
  max_discount_pct: number;
  is_active: boolean;
}

export interface OrderLineRequest {
  product_id: string;
  qty: number;
}

export interface PricedLine {
  product_id: string;
  name_snapshot: string;
  sku_snapshot: string | null;
  unit_price_minor: number;
  tax_rate: number;
  qty: number;
  discount_minor: number;
  tax_minor: number;
  line_total_minor: number;
}

export interface PricedOrder {
  currency: string;
  discount_pct: number;
  subtotal_minor: number;
  discount_minor: number;
  tax_minor: number;
  total_minor: number;
  lines: PricedLine[];
}

export type PricingResult =
  | { ok: true; order: PricedOrder }
  | { ok: false; code: PricingErrorCode; error: string };

export type PricingErrorCode =
  | "empty"
  | "too_many_lines"
  | "bad_qty"
  | "unknown_product"
  | "inactive_product"
  | "mixed_currency"
  | "bad_discount"
  | "discount_above_limit";

export const MAX_ORDER_LINES = 50;
export const MAX_LINE_QTY = 10_000;

function fail(code: PricingErrorCode, error: string): PricingResult {
  return { ok: false, code, error };
}

/**
 * Price a basket. Discount is a percentage applied to every line
 * before tax, and may not exceed ANY line's `max_discount_pct` —
 * `discount_above_limit` is the signal to hand off to a human.
 * Repeated product ids are merged into one line.
 */
export function priceOrder(
  requested: OrderLineRequest[],
  products: PricingProduct[],
  discountPct = 0,
): PricingResult {
  if (!Array.isArray(requested) || requested.length === 0) {
    return fail("empty", "Add at least one product to the order.");
  }
  if (!Number.isFinite(discountPct) || discountPct < 0 || discountPct > 100) {
    return fail("bad_discount", "Discount must be between 0 and 100%.");
  }

  const qtyById = new Map<string, number>();
  for (const line of requested) {
    if (!Number.isInteger(line?.qty) || line.qty < 1 || line.qty > MAX_LINE_QTY) {
      return fail("bad_qty", `Quantity must be a whole number from 1 to ${MAX_LINE_QTY}.`);
    }
    qtyById.set(line.product_id, (qtyById.get(line.product_id) ?? 0) + line.qty);
  }
  if (qtyById.size > MAX_ORDER_LINES) {
    return fail("too_many_lines", `An order can have at most ${MAX_ORDER_LINES} products.`);
  }

  const byId = new Map(products.map((p) => [p.id, p]));
  const lines: PricedLine[] = [];
  let currency: string | null = null;

  for (const [productId, qty] of qtyById) {
    const product = byId.get(productId);
    if (!product) return fail("unknown_product", `Product ${productId} was not found.`);
    if (!product.is_active) {
      return fail("inactive_product", `"${product.name}" is not available right now.`);
    }
    if (qty > MAX_LINE_QTY) {
      return fail("bad_qty", `Quantity must be a whole number from 1 to ${MAX_LINE_QTY}.`);
    }
    if (currency && currency !== product.currency) {
      return fail("mixed_currency", "All products in one order must use the same currency.");
    }
    currency = product.currency;
    if (discountPct > Number(product.max_discount_pct)) {
      return fail(
        "discount_above_limit",
        `"${product.name}" allows at most ${Number(product.max_discount_pct)}% discount.`,
      );
    }

    const gross = product.price_minor * qty;
    const discount = percentOf(gross, discountPct);
    const tax = percentOf(gross - discount, Number(product.tax_rate));
    lines.push({
      product_id: product.id,
      name_snapshot: product.name,
      sku_snapshot: product.sku,
      unit_price_minor: product.price_minor,
      tax_rate: Number(product.tax_rate),
      qty,
      discount_minor: discount,
      tax_minor: tax,
      line_total_minor: gross - discount + tax,
    });
  }

  const sum = (pick: (l: PricedLine) => number) => lines.reduce((acc, l) => acc + pick(l), 0);
  const subtotal = sum((l) => l.unit_price_minor * l.qty);
  const discount = sum((l) => l.discount_minor);
  const tax = sum((l) => l.tax_minor);

  return {
    ok: true,
    order: {
      currency: currency as string,
      discount_pct: discountPct,
      subtotal_minor: subtotal,
      discount_minor: discount,
      tax_minor: tax,
      total_minor: subtotal - discount + tax,
      lines,
    },
  };
}
