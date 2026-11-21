import { describe, expect, it } from "vitest";
import {
  currencyExponent,
  formatMinor,
  minorToAmountString,
  parseAmountToMinor,
  percentOf,
} from "./money";
import { priceOrder, type PricingProduct } from "./pricing";
import { parseCsv, parseProductCsv, validateProductInput } from "./product-input";

describe("money", () => {
  it("knows minor-unit digits per currency", () => {
    expect(currencyExponent("INR")).toBe(2);
    expect(currencyExponent("JPY")).toBe(0);
  });

  it("parses human amounts into minor units", () => {
    expect(parseAmountToMinor("2999", "INR")).toBe(299900);
    expect(parseAmountToMinor("2,999.5", "INR")).toBe(299950);
    expect(parseAmountToMinor("₹ 1499.00", "INR")).toBe(149900);
    expect(parseAmountToMinor("1500", "JPY")).toBe(1500);
  });

  it("rejects negatives, junk and too many decimals", () => {
    expect(parseAmountToMinor("-5", "INR")).toBeNull();
    expect(parseAmountToMinor("abc", "INR")).toBeNull();
    expect(parseAmountToMinor("1.005", "INR")).toBeNull();
    expect(parseAmountToMinor("10.5", "JPY")).toBeNull();
  });

  it("round-trips minor units to an input string", () => {
    expect(minorToAmountString(299900, "INR")).toBe("2999.00");
    expect(minorToAmountString(5, "INR")).toBe("0.05");
    expect(minorToAmountString(1500, "JPY")).toBe("1500");
  });

  it("formats without throwing on an unknown code", () => {
    expect(formatMinor(299900, "INR")).toContain("2,999.00");
    expect(formatMinor(100, "ZZZ")).toMatch(/^ZZZ\s1\.00$/);
  });

  it("rounds percentages half-up in integer maths", () => {
    expect(percentOf(299900, 18)).toBe(53982);
    expect(percentOf(1, 50)).toBe(1);
    expect(percentOf(1000, 12.5)).toBe(125);
  });
});

const plan: PricingProduct = {
  id: "p1",
  name: "3-month plan",
  sku: "PLAN-3M",
  price_minor: 299900,
  currency: "INR",
  tax_rate: 18,
  max_discount_pct: 10,
  is_active: true,
};
const ebook: PricingProduct = { ...plan, id: "p2", name: "Ebook", sku: null, price_minor: 49900, tax_rate: 0 };

describe("priceOrder", () => {
  it("prices from the catalog with tax on top", () => {
    const result = priceOrder([{ product_id: "p1", qty: 1 }], [plan]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order).toMatchObject({
      currency: "INR",
      subtotal_minor: 299900,
      discount_minor: 0,
      tax_minor: 53982,
      total_minor: 353882,
    });
  });

  it("applies the discount before tax and merges repeated lines", () => {
    const result = priceOrder(
      [
        { product_id: "p1", qty: 1 },
        { product_id: "p2", qty: 1 },
        { product_id: "p1", qty: 1 },
      ],
      [plan, ebook],
      10,
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.order.lines).toHaveLength(2);
    const planLine = result.order.lines[0];
    expect(planLine.qty).toBe(2);
    expect(planLine.discount_minor).toBe(59980);
    expect(planLine.tax_minor).toBe(percentOf(599800 - 59980, 18));
    const { subtotal_minor, discount_minor, tax_minor, total_minor } = result.order;
    expect(total_minor).toBe(subtotal_minor - discount_minor + tax_minor);
  });

  it("refuses a discount above the product limit", () => {
    const result = priceOrder([{ product_id: "p1", qty: 1 }], [plan], 15);
    expect(result).toMatchObject({ ok: false, code: "discount_above_limit" });
  });

  it("refuses unknown, inactive, mixed-currency and bad quantities", () => {
    expect(priceOrder([{ product_id: "nope", qty: 1 }], [plan])).toMatchObject({
      code: "unknown_product",
    });
    expect(
      priceOrder([{ product_id: "p1", qty: 1 }], [{ ...plan, is_active: false }]),
    ).toMatchObject({ code: "inactive_product" });
    expect(
      priceOrder(
        [
          { product_id: "p1", qty: 1 },
          { product_id: "p2", qty: 1 },
        ],
        [plan, { ...ebook, currency: "USD" }],
      ),
    ).toMatchObject({ code: "mixed_currency" });
    expect(priceOrder([{ product_id: "p1", qty: 0 }], [plan])).toMatchObject({ code: "bad_qty" });
    expect(priceOrder([{ product_id: "p1", qty: 1.5 }], [plan])).toMatchObject({ code: "bad_qty" });
    expect(priceOrder([], [plan])).toMatchObject({ code: "empty" });
  });
});

describe("validateProductInput", () => {
  it("accepts a full product and defaults the currency", () => {
    const result = validateProductInput(
      { name: " Plan ", price: "2999", tax_rate: "18%", max_discount_pct: "10", active: "yes" },
      "INR",
    );
    expect(result).toEqual({
      ok: true,
      product: {
        name: "Plan",
        sku: null,
        description: null,
        price_minor: 299900,
        currency: "INR",
        tax_rate: 18,
        max_discount_pct: 10,
        is_active: true,
      },
    });
  });

  it("explains what is wrong", () => {
    expect(validateProductInput({ price: "1" }, "INR")).toMatchObject({ ok: false });
    expect(validateProductInput({ name: "x", price: "free" }, "INR")).toMatchObject({
      ok: false,
      error: expect.stringContaining("not a valid"),
    });
    expect(validateProductInput({ name: "x", price: "1", tax_rate: "120" }, "INR")).toMatchObject({
      ok: false,
    });
    expect(validateProductInput({ name: "x", price: "1", currency: "rupees" }, "INR")).toMatchObject({
      ok: false,
    });
  });
});

describe("CSV", () => {
  it("handles quoted commas, escaped quotes and line breaks", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi""\nthere"\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"\nthere'],
    ]);
  });

  it("maps header aliases and reports per-line errors", () => {
    const csv = [
      "Product,Code,Price,GST",
      "Plan,PLAN-3M,2999,18",
      "Broken,,abc,0",
      "Plan again,plan-3m,10,0",
    ].join("\n");
    const parsed = parseProductCsv(csv, "INR");
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.rows.map((r) => [r.line, r.result.ok])).toEqual([
      [2, true],
      [3, false],
      [4, false],
    ]);
    expect(parsed.rows[2].result).toMatchObject({ error: "SKU repeats line 2." });
  });

  it("requires name and price columns", () => {
    expect(parseProductCsv("sku,cost\nA,1", "INR")).toMatchObject({ ok: false });
  });
});
