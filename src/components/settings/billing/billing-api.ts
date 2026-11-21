// Tiny fetch wrapper for the billing routes. The browser never sends an
// amount: only plan ids, UTR text and a cancel flag.

export type ApiResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

export async function billingRequest<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, { cache: 'no-store', ...init });
    const payload = await res.json().catch(() => null);
    if (res.ok) return { ok: true, data: payload as T };
    const error = payload?.error;
    return {
      ok: false,
      code: typeof error === 'object' && error?.code ? String(error.code) : 'request_failed',
      message:
        typeof error === 'object' && error?.message
          ? String(error.message)
          : typeof error === 'string'
            ? error
            : 'Something went wrong. Please try again.',
    };
  } catch {
    return { ok: false, code: 'network', message: 'Network error. Check your connection and try again.' };
  }
}

export function postJson<T>(url: string, body: unknown, headers?: Record<string, string>) {
  return billingRequest<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
