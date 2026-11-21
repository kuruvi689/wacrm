/**
 * Money helpers for the catalog and orders. Amounts are stored as
 * integer minor units (paise, cents; whole yen) — see migration 039.
 * Pure and unit-tested; no I/O.
 */

/** ISO-4217 shape check. Postgres enforces the same `^[A-Z]{3}$`. */
export function isCurrencyCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value);
}

/**
 * Number of minor-unit digits for a currency (INR 2, JPY 0, BHD 3).
 * Falls back to 2 for codes `Intl` does not recognise.
 */
export function currencyExponent(currency: string): number {
  try {
    return (
      new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/**
 * Parse a human amount ("2999", "2,999.50", "₹ 1499") into minor units.
 * Returns null for anything that is not a non-negative number with at
 * most the currency's number of decimals.
 */
export function parseAmountToMinor(input: string | number, currency: string): number | null {
  const exponent = currencyExponent(currency);
  const text = String(input).replace(/[\s,]/g, "").replace(/^[^\d.-]+/, "");
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const [, whole, fraction = ""] = match;
  if (fraction.length > exponent) return null;
  const minor = Number(whole + fraction.padEnd(exponent, "0"));
  return Number.isSafeInteger(minor) ? minor : null;
}

/** Minor units → plain decimal string for inputs ("2999.00"). */
export function minorToAmountString(minor: number, currency: string): string {
  const exponent = currencyExponent(currency);
  if (exponent === 0) return String(minor);
  const digits = String(Math.abs(minor)).padStart(exponent + 1, "0");
  const sign = minor < 0 ? "-" : "";
  return `${sign}${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}

/** Minor units → localised currency string ("₹2,999.00"). Never throws. */
export function formatMinor(minor: number, currency: string, locale = "en-IN"): string {
  const exponent = currencyExponent(currency);
  const major = minor / 10 ** exponent;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    }).format(major);
  } catch {
    return `${currency} ${major.toFixed(exponent)}`;
  }
}

/**
 * `amount × pct / 100`, rounded half-up to a whole minor unit.
 * `pct` is held to 2 decimals (NUMERIC(5,2)) so the maths stays in
 * integers: no float drift on values like 12.5% or 0.1%.
 */
export function percentOf(amountMinor: number, pct: number): number {
  const basisPoints = Math.round(pct * 100);
  return Math.floor((amountMinor * basisPoints + 5000) / 10000);
}
