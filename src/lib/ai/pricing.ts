import type { AiUsage } from './types'

// ============================================================
// ESTIMATE ONLY — USD per 1M tokens, update manually.
//
// Provider list prices drift and differ by region / batch / caching
// discount, so this table is a rough guide for the Usage + Agents
// screens, never an invoice. A model that matches no entry returns
// `null` cost ("unknown") rather than a made-up number.
// Matching is by longest model-id prefix, so dated snapshots
// ("claude-haiku-4-5-20251001") resolve to their family.
// ============================================================

interface Price {
  /** USD per 1M input (prompt) tokens. */
  input: number
  /** USD per 1M output (completion) tokens. */
  output: number
}

export const MODEL_PRICES_USD_PER_MTOK: Record<string, Price> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1': { input: 2, output: 8 },
  'claude-haiku': { input: 0.8, output: 4 },
  'claude-sonnet': { input: 3, output: 15 },
}

function findPrice(model: string): Price | null {
  const id = model.toLowerCase()
  let best: string | null = null
  for (const key of Object.keys(MODEL_PRICES_USD_PER_MTOK)) {
    if (id.startsWith(key) && (!best || key.length > best.length)) best = key
  }
  // Anthropic ids put the family after the major version too
  // ("claude-3-5-haiku-…", "claude-haiku-4-5-…"); match either shape.
  if (!best && id.startsWith('claude')) {
    if (id.includes('haiku')) best = 'claude-haiku'
    else if (id.includes('sonnet')) best = 'claude-sonnet'
  }
  return best ? MODEL_PRICES_USD_PER_MTOK[best] : null
}

/**
 * Estimated cost of one call in micro-USD (1e-6 USD), or null when the
 * model is unknown or no usage was reported.
 */
export function estimateCostMicros(
  model: string,
  usage: AiUsage | null,
): number | null {
  if (!usage) return null
  const price = findPrice(model)
  if (!price) return null
  // $/Mtok == micro-USD/token, so tokens × price is already micro-USD.
  return Math.round(
    usage.promptTokens * price.input + usage.completionTokens * price.output,
  )
}
