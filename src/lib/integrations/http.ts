import 'server-only';

/**
 * Error classification used to decide whether a failed call may be retried and,
 * for shipment creation, whether the parcel MAY have been created anyway.
 *  - validation / auth / not_found: definitive, nothing was created
 *  - rate_limited: not processed, safe to retry later
 *  - ambiguous: timeout / network / 5xx — outcome unknown, must reconcile first
 */
export type ProviderErrorKind = 'validation' | 'auth' | 'not_found' | 'rate_limited' | 'ambiguous';

export class ProviderError extends Error {
  constructor(
    public readonly kind: ProviderErrorKind,
    message: string,
    public readonly status?: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
  get retryable() {
    return this.kind === 'rate_limited' || this.kind === 'ambiguous';
  }
}

export type HttpRequest = {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
  json?: unknown;
  form?: Record<string, string>;
  timeoutMs?: number;
};

export async function httpJson<T = unknown>(req: HttpRequest): Promise<{ status: number; data: T; text: string }> {
  const url = new URL(req.url);
  for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const headers: Record<string, string> = { Accept: 'application/json', ...req.headers };
  let body: string | undefined;
  if (req.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(req.json);
  } else if (req.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(req.form).toString();
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: req.method ?? 'GET',
      headers,
      body,
      signal: AbortSignal.timeout(req.timeoutMs ?? 20000),
      cache: 'no-store',
    });
  } catch (e) {
    throw new ProviderError('ambiguous', `network_error: ${(e as Error).message}`);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (res.ok) return { status: res.status, data: data as T, text };
  const msg = typeof data === 'object' && data && 'message' in data ? String((data as { message: unknown }).message) : text.slice(0, 300);
  if (res.status === 401 || res.status === 403) throw new ProviderError('auth', msg || 'unauthorized', res.status, data);
  if (res.status === 404) throw new ProviderError('not_found', msg || 'not_found', res.status, data);
  if (res.status === 429) throw new ProviderError('rate_limited', msg || 'rate_limited', res.status, data);
  if (res.status >= 500 || res.status === 408) throw new ProviderError('ambiguous', msg || `http_${res.status}`, res.status, data);
  throw new ProviderError('validation', msg || `http_${res.status}`, res.status, data);
}

/** Retry helper for idempotent reads (polling / sync), with exponential backoff. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseMs = 800): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const retryable = e instanceof ProviderError ? e.retryable : true;
      if (!retryable || i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, baseMs * 2 ** i + Math.random() * 200));
    }
  }
  throw last;
}
