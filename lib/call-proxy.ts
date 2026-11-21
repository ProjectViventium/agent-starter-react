import { type CallIssueKind, callIssueFromResponse } from '@/lib/call-start';

/**
 * The one definition of a call-scoped identifier (call session, task, turn, segment and
 * presentation ids). The pre-hydration bootstrap script (`lib/call-capability-bootstrap.ts`)
 * carries its own copy because it cannot import; keep the two in step.
 */
export const CALL_IDENTIFIER_PATTERN = /^(?![.]{1,2}$)[A-Za-z0-9._:-]{1,160}$/;

export function parseCallIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return CALL_IDENTIFIER_PATTERN.test(normalized) ? normalized : null;
}

export function parseTaskInput(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 8_000 ? normalized : null;
}

/** BFF error body `{ code, message, retryable }`; same mapping as `callIssueFromResponse`. */
export function normalizeProxyFailure(
  status: number,
  payload: unknown
): { code: CallIssueKind; message: string; retryable: boolean } {
  const issue = callIssueFromResponse(status, Array.isArray(payload) ? null : payload);
  return { code: issue.kind, message: issue.message, retryable: issue.retryable === true };
}
