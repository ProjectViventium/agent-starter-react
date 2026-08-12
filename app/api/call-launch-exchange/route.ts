/* VIVENTIUM START
 * Purpose: Exchange a single-use Telegram launch bearer for per-session browser authority without
 * exposing the global LibreChat secret or placing either bearer in URLs, bodies, logs, or caches.
 * VIVENTIUM END */
import { NextResponse } from 'next/server';
import { normalizeProxyFailure, parseCallIdentifier } from '@/lib/call-proxy';

const LAUNCH_HEADER = 'X-VIVENTIUM-CALL-LAUNCH';
const IDEMPOTENCY_HEADER = 'X-VIVENTIUM-CALL-LAUNCH-IDEMPOTENCY';
const SAFE_CAPABILITY = /^[A-Za-z0-9_-]{43}$/;

function responseHeaders(): HeadersInit {
  return {
    'Cache-Control': 'no-store, private',
    Pragma: 'no-cache',
    'Referrer-Policy': 'no-referrer',
  };
}

export async function POST(request: Request) {
  const callSessionId = parseCallIdentifier(new URL(request.url).searchParams.get('callSessionId'));
  const launchCapability = request.headers.get(LAUNCH_HEADER)?.trim() || '';
  const idempotencyCapability = request.headers.get(IDEMPOTENCY_HEADER)?.trim() || '';
  if (!callSessionId) {
    return NextResponse.json(
      { code: 'unknown', message: 'A valid callSessionId is required.', retryable: false },
      { status: 400, headers: responseHeaders() }
    );
  }
  if (!SAFE_CAPABILITY.test(launchCapability) || !SAFE_CAPABILITY.test(idempotencyCapability)) {
    return NextResponse.json(
      { code: 'auth_expired', message: 'The call link is missing or invalid.', retryable: false },
      { status: 401, headers: responseHeaders() }
    );
  }
  const origin = process.env.VIVENTIUM_LIBRECHAT_ORIGIN;
  const secret = process.env.VIVENTIUM_CALL_SESSION_SECRET;
  if (!origin || !secret) {
    return NextResponse.json(
      { code: 'gateway_down', message: 'Calling is not configured.', retryable: true },
      { status: 503, headers: responseHeaders() }
    );
  }
  try {
    const target = new URL(
      `/api/viventium/calls/${encodeURIComponent(callSessionId)}/browser-capability/exchange`,
      origin
    );
    const response = await fetch(target.toString(), {
      method: 'POST',
      headers: {
        'X-VIVENTIUM-CALL-SECRET': secret,
        [LAUNCH_HEADER]: launchCapability,
        [IDEMPOTENCY_HEADER]: idempotencyCapability,
      },
      cache: 'no-store',
      redirect: 'error',
    });
    const text = await response.text();
    let payload: unknown = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = {};
      }
    }
    if (!response.ok) {
      return NextResponse.json(normalizeProxyFailure(response.status, payload), {
        status: response.status,
        headers: responseHeaders(),
      });
    }
    const value =
      payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    if (
      value.version !== 1 ||
      value.callSessionId !== callSessionId ||
      typeof value.browserCapability !== 'string' ||
      !SAFE_CAPABILITY.test(value.browserCapability)
    ) {
      return NextResponse.json(
        { code: 'gateway_down', message: 'The call launch response was invalid.', retryable: true },
        { status: 503, headers: responseHeaders() }
      );
    }
    return NextResponse.json(
      {
        version: 1,
        callSessionId,
        browserCapability: value.browserCapability,
        ...(typeof value.expiresAt === 'string' ? { expiresAt: value.expiresAt } : {}),
      },
      { headers: responseHeaders() }
    );
  } catch {
    return NextResponse.json(
      { code: 'gateway_down', message: 'Calling is temporarily unavailable.', retryable: true },
      { status: 503, headers: responseHeaders() }
    );
  }
}
