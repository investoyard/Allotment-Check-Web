import { RetryableError } from "./types.js";

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

export type Fetch = typeof fetch;

/** Parses Retry-After (seconds or HTTP date) into ms, capped at 5 minutes. */
export function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 5 * 60_000) : undefined;
}

/**
 * fetch with a timeout and consistent error classification:
 * network errors, timeouts, 429 and 5xx → RetryableError; other non-2xx → Error,
 * except statuses listed in `okStatuses`, which are returned for the caller to handle.
 */
export async function request(
  fetchFn: Fetch,
  label: string,
  url: string,
  init: RequestInit & { timeoutMs?: number; okStatuses?: number[] } = {},
): Promise<Response> {
  const { timeoutMs = 20_000, okStatuses = [], ...rest } = init;
  let res: Response;
  try {
    res = await fetchFn(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new RetryableError(`${label}: ${(err as Error).message}`);
  }
  if (res.ok || okStatuses.includes(res.status)) return res;
  if (res.status === 429 || res.status >= 500) {
    throw new RetryableError(`${label}: HTTP ${res.status}`, retryAfterMs(res.headers.get("retry-after")));
  }
  throw new Error(`${label}: HTTP ${res.status}`);
}

/** Parses JSON; an HTML error page served with 200 (common when overloaded) is retryable. */
export async function readJson<T>(res: Response, label: string): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new RetryableError(`${label}: unexpected non-JSON response`);
  }
}
