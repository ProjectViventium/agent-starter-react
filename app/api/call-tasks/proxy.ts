import { NextResponse } from 'next/server';
import { CALL_CAPABILITY_HEADER } from '@/lib/call-browser-capability';
import { normalizeProxyFailure } from '@/lib/call-proxy';

function config() {
  const origin = process.env.VIVENTIUM_LIBRECHAT_ORIGIN;
  const secret = process.env.VIVENTIUM_CALL_SESSION_SECRET;
  if (!origin || !secret) {
    return null;
  }
  const configuredTimeout = Number(process.env.VIVENTIUM_CALL_PROXY_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(configuredTimeout) && configuredTimeout >= 1 && configuredTimeout <= 60_000
      ? configuredTimeout
      : 4_500;
  return { origin, secret, timeoutMs };
}

export async function proxyCallTaskRequest(
  path: string,
  method: 'GET' | 'POST',
  callSessionId: string,
  browserCapability: string,
  body?: Record<string, unknown>
) {
  const runtime = config();
  if (!runtime) {
    return NextResponse.json(
      {
        code: 'gateway_down',
        message: 'The voice task runtime is not configured.',
        retryable: false,
      },
      { status: 503 }
    );
  }

  const target = new URL(path, runtime.origin);
  const querySessionId = target.searchParams.get('callSessionId');
  const bodySessionId = body?.callSessionId;
  if (
    (querySessionId && querySessionId !== callSessionId) ||
    (typeof bodySessionId === 'string' && bodySessionId !== callSessionId)
  ) {
    return NextResponse.json(
      { code: 'unknown', message: 'Call session identifiers do not match.', retryable: false },
      { status: 400 }
    );
  }

  let response: Response;
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, runtime.timeoutMs);
  try {
    response = await fetch(target, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-VIVENTIUM-CALL-SECRET': runtime.secret,
        'X-VIVENTIUM-CALL-SESSION': callSessionId,
        [CALL_CAPABILITY_HEADER]: browserCapability,
      },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch {
    if (timedOut) {
      return NextResponse.json(
        {
          code: 'gateway_down',
          message: 'The voice task runtime did not respond before the request timed out.',
          retryable: true,
        },
        { status: 504 }
      );
    }
    return NextResponse.json(
      {
        code: 'gateway_down',
        message: 'Viventium could not reach the voice task runtime.',
        retryable: true,
      },
      { status: 503 }
    );
  } finally {
    clearTimeout(timeoutId);
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    return NextResponse.json(normalizeProxyFailure(response.status, payload), {
      status: response.status,
    });
  }
  return NextResponse.json(payload ?? {}, {
    status: response.status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
