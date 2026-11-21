/*
 * Launch-code exchange proxy (CP-APP-018): swaps a single-use launch bearer (Telegram links)
 * for the per-call browser capability, without exposing the shared Core secret and without
 * placing either bearer in a URL, body, log or cache.
 */
import { NextResponse } from 'next/server';
import { corePaths, coreRequest, readCoreText } from '@/app/api/call-tasks/proxy';
import { normalizeProxyFailure, parseCallIdentifier } from '@/lib/call-proxy';

const LAUNCH_HEADER = 'X-VIVENTIUM-CALL-LAUNCH';
const IDEMPOTENCY_HEADER = 'X-VIVENTIUM-CALL-LAUNCH-IDEMPOTENCY';
const SAFE_CAPABILITY = /^[A-Za-z0-9_-]{43}$/;
const RESPONSE_HEADERS = {
  'Cache-Control': 'no-store, private',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
} as const;

function failure(
  code: 'unknown' | 'auth_expired' | 'gateway_down',
  message: string,
  retryable: boolean,
  status: number
) {
  return NextResponse.json({ code, message, retryable }, { status, headers: RESPONSE_HEADERS });
}

export async function POST(request: Request) {
  const callSessionId = parseCallIdentifier(new URL(request.url).searchParams.get('callSessionId'));
  const launchCapability = request.headers.get(LAUNCH_HEADER)?.trim() || '';
  const idempotencyCapability = request.headers.get(IDEMPOTENCY_HEADER)?.trim() || '';
  if (!callSessionId) {
    return failure('unknown', 'A valid callSessionId is required.', false, 400);
  }
  if (!SAFE_CAPABILITY.test(launchCapability) || !SAFE_CAPABILITY.test(idempotencyCapability)) {
    return failure('auth_expired', 'The call link is missing or invalid.', false, 401);
  }

  const outcome = await coreRequest({
    path: corePaths.browserCapabilityExchange(callSessionId),
    method: 'POST',
    // Bearers travel only in their dedicated headers; this Core route takes no body.
    headers: {
      [LAUNCH_HEADER]: launchCapability,
      [IDEMPOTENCY_HEADER]: idempotencyCapability,
    },
    jsonContentType: false,
    redirect: 'error',
    cancelWith: request.signal,
    readBody: readCoreText(() => ({})),
  });
  if (outcome.kind === 'unconfigured') {
    return failure('gateway_down', 'Calling is not configured.', true, 503);
  }
  if (outcome.kind === 'timeout') {
    return failure('gateway_down', 'Calling timed out. Please try again.', true, 504);
  }
  if (outcome.kind === 'unreachable') {
    return failure('gateway_down', 'Calling is temporarily unavailable.', true, 503);
  }
  if (!outcome.ok) {
    return NextResponse.json(normalizeProxyFailure(outcome.status, outcome.payload ?? {}), {
      status: outcome.status,
      headers: RESPONSE_HEADERS,
    });
  }

  const value =
    outcome.payload && typeof outcome.payload === 'object'
      ? (outcome.payload as Record<string, unknown>)
      : {};
  if (
    value.version !== 1 ||
    value.callSessionId !== callSessionId ||
    typeof value.browserCapability !== 'string' ||
    !SAFE_CAPABILITY.test(value.browserCapability)
  ) {
    return failure('gateway_down', 'The call launch response was invalid.', true, 503);
  }
  return NextResponse.json(
    {
      version: 1,
      callSessionId,
      browserCapability: value.browserCapability,
      ...(typeof value.expiresAt === 'string' ? { expiresAt: value.expiresAt } : {}),
    },
    { headers: RESPONSE_HEADERS }
  );
}
