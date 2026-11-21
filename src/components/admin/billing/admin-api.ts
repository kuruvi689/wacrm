// Fetch wrapper for the operator billing routes. Errors come back either
// as { error: { code, message } } or, from the auth gate, { error: 'text' }.

export type AdminResult<T> = { ok: true; data: T } | { ok: false; message: string }

export async function adminRequest<T>(url: string, body?: unknown): Promise<AdminResult<T>> {
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      ...(body === undefined
        ? {}
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
    const payload = await res.json().catch(() => null)
    if (res.ok) return { ok: true, data: payload as T }
    const error = payload?.error
    const message =
      typeof error === 'object' && error?.message ? String(error.message) : typeof error === 'string' ? error : 'Request failed'
    return { ok: false, message }
  } catch {
    return { ok: false, message: 'Network error. Try again.' }
  }
}
