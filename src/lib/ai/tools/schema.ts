// ============================================================
// JSON-schema-lite validator for tool arguments (no dependencies).
//
// Supports the subset our tool definitions use: type (string, number,
// integer, boolean, array, object), enum, minLength/maxLength,
// minimum/maximum, items, properties/required, maxItems, maxProperties,
// and `additionalProperties` (false | true | schema). Objects reject
// unknown keys by default so a model cannot smuggle extra fields (e.g. a
// different contact id) past the server-side binding.
// ============================================================

export interface SchemaLite {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'
  description?: string
  enum?: readonly (string | number)[]
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  items?: SchemaLite
  maxItems?: number
  properties?: Record<string, SchemaLite>
  required?: readonly string[]
  additionalProperties?: boolean | SchemaLite
  maxProperties?: number
}

export type ValidationResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string }

const MAX_DEPTH = 5

function fail(path: string, msg: string): ValidationResult {
  return { ok: false, error: `${path} ${msg}` }
}

export function validateAgainst(
  schema: SchemaLite,
  value: unknown,
  path = 'args',
  depth = 0,
): ValidationResult {
  if (depth > MAX_DEPTH) return { ok: false, error: `${path}: too deeply nested` }

  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') return fail(path, 'must be a string')
      if (schema.minLength !== undefined && value.length < schema.minLength)
        return fail(path, `must be at least ${schema.minLength} characters`)
      if (schema.maxLength !== undefined && value.length > schema.maxLength)
        return fail(path, `must be at most ${schema.maxLength} characters`)
      if (schema.enum && !schema.enum.includes(value))
        return fail(path, `must be one of ${schema.enum.join(', ')}`)
      return { ok: true, value }
    }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value))
        return fail(path, 'must be a number')
      if (schema.type === 'integer' && !Number.isInteger(value))
        return fail(path, 'must be an integer')
      if (schema.minimum !== undefined && value < schema.minimum)
        return fail(path, `must be >= ${schema.minimum}`)
      if (schema.maximum !== undefined && value > schema.maximum)
        return fail(path, `must be <= ${schema.maximum}`)
      return { ok: true, value }
    }
    case 'boolean':
      return typeof value === 'boolean'
        ? { ok: true, value }
        : fail(path, 'must be a boolean')
    case 'array': {
      if (!Array.isArray(value)) return fail(path, 'must be an array')
      if (schema.maxItems !== undefined && value.length > schema.maxItems)
        return fail(path, `must have at most ${schema.maxItems} items`)
      if (!schema.items) return { ok: true, value }
      const out: unknown[] = []
      for (let i = 0; i < value.length; i++) {
        const r = validateAgainst(schema.items, value[i], `${path}[${i}]`, depth + 1)
        if (!r.ok) return r
        out.push(r.value)
      }
      return { ok: true, value: out }
    }
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        return fail(path, 'must be an object')
      const obj = value as Record<string, unknown>
      const keys = Object.keys(obj)
      if (schema.maxProperties !== undefined && keys.length > schema.maxProperties)
        return fail(path, `must have at most ${schema.maxProperties} properties`)
      for (const req of schema.required ?? []) {
        if (obj[req] === undefined) return fail(`${path}.${req}`, 'is required')
      }
      const out: Record<string, unknown> = {}
      for (const key of keys) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype')
          return fail(`${path}.${key}`, 'is not allowed')
        const prop = schema.properties?.[key]
        if (prop) {
          const r = validateAgainst(prop, obj[key], `${path}.${key}`, depth + 1)
          if (!r.ok) return r
          out[key] = r.value
        } else if (schema.additionalProperties === true) {
          out[key] = obj[key]
        } else if (
          schema.additionalProperties &&
          typeof schema.additionalProperties === 'object'
        ) {
          const r = validateAgainst(
            schema.additionalProperties,
            obj[key],
            `${path}.${key}`,
            depth + 1,
          )
          if (!r.ok) return r
          out[key] = r.value
        } else {
          return fail(`${path}.${key}`, 'is not an allowed field')
        }
      }
      return { ok: true, value: out }
    }
    default:
      return fail(path, 'unsupported schema type')
  }
}

/** Redacted one-line summary of tool args for the audit log: key names
 *  and sizes only ("query:str(34),tags:arr(2)"), never the values. */
export function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return ''
  return Object.entries(args as Record<string, unknown>)
    .slice(0, 12)
    .map(([k, v]) => {
      if (typeof v === 'string') return `${k}:str(${v.length})`
      if (Array.isArray(v)) return `${k}:arr(${v.length})`
      if (v && typeof v === 'object') return `${k}:obj(${Object.keys(v).length})`
      return `${k}:${typeof v}`
    })
    .join(',')
    .slice(0, 300)
}
