/* VIVENTIUM START
 * Purpose: Keep the raw per-call browser capability out of query strings, request bodies,
 * persistent storage, logs, React state, and referrers while preserving zero-step reconnects.
 * VIVENTIUM END */

export const CALL_CAPABILITY_FRAGMENT_KEY = 'viventiumCallCapability';
export const CALL_CAPABILITY_HEADER = 'X-VIVENTIUM-CALL-CAPABILITY';
const CALL_CAPABILITY_STORAGE_PREFIX = 'viventium.call.capability.v1:';
const CALL_OPENER_ORIGIN_STORAGE_PREFIX = 'viventium.call.opener-origin.v1:';
const SAFE_CALL_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const SAFE_CAPABILITY = /^[A-Za-z0-9_-]{43}$/;

export function callCapabilityStorageKey(callSessionId: string): string | null {
  return SAFE_CALL_ID.test(callSessionId)
    ? `${CALL_CAPABILITY_STORAGE_PREFIX}${callSessionId}`
    : null;
}

export function captureCallBrowserCapability({
  search,
  hash,
  pathname,
  storage,
  replaceUrl,
}: {
  search: string;
  hash: string;
  pathname: string;
  storage: Pick<Storage, 'setItem'>;
  replaceUrl: (url: string) => void;
}): boolean {
  const callSessionId = new URLSearchParams(search).get('callSessionId')?.trim() || '';
  const rawHash = hash.startsWith('#') ? hash.slice(1) : hash;
  const capability = new URLSearchParams(rawHash).get(CALL_CAPABILITY_FRAGMENT_KEY)?.trim() || '';
  const storageKey = callCapabilityStorageKey(callSessionId);

  // Strip any fragment before the first request even when it is malformed. This prevents a bad
  // capability from lingering in copied URLs, screenshots, browser history, or referrer state.
  if (hash) {
    replaceUrl(`${pathname}${search}`);
  }
  if (!storageKey || !SAFE_CAPABILITY.test(capability)) {
    return false;
  }
  storage.setItem(storageKey, capability);
  return true;
}

export function readCallBrowserCapability(
  callSessionId: string,
  storage: Pick<Storage, 'getItem'> | null = typeof window === 'undefined'
    ? null
    : window.sessionStorage
): string | null {
  const key = callCapabilityStorageKey(callSessionId);
  if (!key || !storage) return null;
  const capability = storage.getItem(key);
  return capability && SAFE_CAPABILITY.test(capability) ? capability : null;
}

export function clearCallBrowserCapability(
  callSessionId: string,
  storage: Pick<Storage, 'removeItem'> | null = typeof window === 'undefined'
    ? null
    : window.sessionStorage
): void {
  const key = callCapabilityStorageKey(callSessionId);
  if (key && storage) {
    storage.removeItem(key);
    storage.removeItem(`${CALL_OPENER_ORIGIN_STORAGE_PREFIX}${callSessionId}`);
  }
}

export function readCallOpenerOrigin(
  callSessionId: string,
  storage: Pick<Storage, 'getItem'> | null = typeof window === 'undefined'
    ? null
    : window.sessionStorage
): string | null {
  if (!SAFE_CALL_ID.test(callSessionId) || !storage) return null;
  const value = storage.getItem(`${CALL_OPENER_ORIGIN_STORAGE_PREFIX}${callSessionId}`);
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.origin === value
      ? value
      : null;
  } catch {
    return null;
  }
}

export function callBrowserCapabilityHeaders(callSessionId: string): Record<string, string> {
  const capability = readCallBrowserCapability(callSessionId);
  return capability ? { [CALL_CAPABILITY_HEADER]: capability } : {};
}

export function readRequestCallBrowserCapability(request: Request): string | null {
  const capability = request.headers.get(CALL_CAPABILITY_HEADER)?.trim() || '';
  return SAFE_CAPABILITY.test(capability) ? capability : null;
}
