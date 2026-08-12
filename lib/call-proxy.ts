import type { CallIssueKind } from '@/lib/call-start';

const PUBLIC_ERROR_CODES = new Set<CallIssueKind>([
  'auth_expired',
  'mic_denied',
  'microphone_missing',
  'no_route',
  'gateway_down',
  'provider_failure',
  'unknown',
]);

export function parseCallIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 160 && /^[A-Za-z0-9._:-]+$/.test(normalized)
    ? normalized
    : null;
}

export function parseTaskInput(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 8_000 ? normalized : null;
}

export function normalizeProxyFailure(
  status: number,
  payload: unknown
): { code: CallIssueKind; message: string; retryable: boolean } {
  const value =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const code =
    typeof value.code === 'string' && PUBLIC_ERROR_CODES.has(value.code as CallIssueKind)
      ? (value.code as CallIssueKind)
      : status === 401 || status === 410
        ? 'auth_expired'
        : status >= 500
          ? 'gateway_down'
          : 'unknown';
  const message =
    typeof value.message === 'string' && value.message.trim()
      ? value.message.trim().slice(0, 2_000)
      : 'The call request failed.';
  return { code, message, retryable: value.retryable === true };
}
