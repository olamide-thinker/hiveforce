/**
 * Thin fetch wrapper around the NestJS backend.
 *
 * Responsibilities:
 *   1. Attach the current Firebase ID token as a Bearer header.
 *   2. Prepend EXPO_PUBLIC_API_BASE so callers can use bare paths
 *      like `/api/projects`.
 *   3. Normalise the success/error shape — backend responses are
 *      `{ success: boolean, data?, message?, error? }` or, for
 *      thrown HTTPExceptions, a Nest-shaped error body. We throw on
 *      non-2xx and otherwise return parsed JSON.
 *
 * This is the v1 wrapper for Phase 1a. Phase 1b will hand most of
 * this off to @syncsalez-dev/sync-core (which owns retry, outbox,
 * idempotency-key generation, etc.). The direct fetch surface stays
 * here for ad-hoc calls that don't fit the sync model (login,
 * health probes, one-off RPC).
 */
import { auth } from './firebase';

const API_BASE = process.env.EXPO_PUBLIC_API_BASE || '';

if (!API_BASE && __DEV__) {
  // eslint-disable-next-line no-console
  console.warn(
    '[api] EXPO_PUBLIC_API_BASE is unset — every request will hit a relative URL and fail. Set it in .env.',
  );
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: any,
    message?: string,
  ) {
    super(message || `HTTP ${status}`);
    this.name = 'ApiError';
  }
}

interface Options extends RequestInit {
  /** Bypass the Bearer-token attach (used by anonymous probes like /healthz). */
  anonymous?: boolean;
}

export async function api<T = any>(path: string, opts: Options = {}): Promise<T> {
  const { anonymous, headers, ...rest } = opts;

  const finalHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(headers as Record<string, string> | undefined),
  };

  if (!anonymous) {
    const user = auth.currentUser;
    if (!user) {
      throw new ApiError(401, null, 'Not signed in');
    }
    // forceRefresh:false — Firebase auto-refreshes the token when it's
    // within 5 min of expiry. Forcing it on every request would be wasteful.
    const token = await user.getIdToken();
    finalHeaders.Authorization = `Bearer ${token}`;
  }

  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const res = await fetch(url, { ...rest, headers: finalHeaders });

  // Parse JSON only when there is a body. /healthz returns one, but
  // delete endpoints often return 204 No Content.
  let body: any = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!res.ok) {
    const msg =
      (body && (body.message || body.error)) ||
      `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, body, String(msg));
  }
  return body as T;
}

// Sugar for the common verb wrappers.
export const apiGet = <T = any>(path: string, opts: Options = {}) =>
  api<T>(path, { ...opts, method: 'GET' });

export const apiPost = <T = any>(path: string, body?: any, opts: Options = {}) =>
  api<T>(path, {
    ...opts,
    method: 'POST',
    body: body != null ? JSON.stringify(body) : undefined,
  });

export const apiPatch = <T = any>(path: string, body?: any, opts: Options = {}) =>
  api<T>(path, {
    ...opts,
    method: 'PATCH',
    body: body != null ? JSON.stringify(body) : undefined,
  });

export const apiDelete = <T = any>(path: string, opts: Options = {}) =>
  api<T>(path, { ...opts, method: 'DELETE' });
