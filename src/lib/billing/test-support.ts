// Test-only helpers for the billing route tests (never imported by app code).
// A tiny chainable Supabase stand-in: every query-builder method returns the
// builder, and awaiting it (or maybeSingle/single) yields the table fixture.

export interface RpcCall {
  fn: string
  args: Record<string, unknown>
}

type RpcResult = { data: unknown; error: { message: string; code?: string } | null }

export interface FakeAdmin {
  from: (table: string) => unknown
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<RpcResult>
  calls: RpcCall[]
}

export function makeFakeAdmin(
  tables: Record<string, unknown>,
  rpc: (fn: string, args: Record<string, unknown>) => RpcResult = () => ({ data: null, error: null }),
): FakeAdmin {
  const calls: RpcCall[] = []

  function builder(table: string): unknown {
    const fixture = tables[table] ?? null
    const asList = () => (Array.isArray(fixture) ? fixture : fixture ? [fixture] : [])
    const asOne = () => (Array.isArray(fixture) ? (fixture[0] ?? null) : fixture)
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown) => resolve({ data: asList(), error: null })
        }
        if (prop === 'maybeSingle' || prop === 'single') {
          return () => Promise.resolve({ data: asOne(), error: null })
        }
        return () => proxy
      },
    }
    const proxy: object = new Proxy({}, handler)
    return proxy
  }

  return {
    calls,
    from: builder,
    rpc: (fn, args = {}) => {
      calls.push({ fn, args })
      return Promise.resolve(rpc(fn, args))
    },
  }
}
