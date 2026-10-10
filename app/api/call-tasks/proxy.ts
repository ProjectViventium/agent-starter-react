import { NextResponse } from 'next/server';
import { CALL_CAPABILITY_HEADER } from '@/lib/call-browser-capability';
import { normalizeProxyFailure, parseCallIdentifier } from '@/lib/call-proxy';
import { parseTaskEvent } from '@/lib/voice-events';

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

function parseCancellationConflict(
  payload: unknown,
  target: URL,
  method: 'GET' | 'POST',
  callSessionId: string
) {
  const prefix = '/api/viventium/voice/tasks/';
  const suffix = '/cancel';
  if (
    method !== 'POST' ||
    !target.pathname.startsWith(prefix) ||
    !target.pathname.endsWith(suffix) ||
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  ) {
    return null;
  }
  let taskId: string | null;
  try {
    taskId = parseCallIdentifier(
      decodeURIComponent(target.pathname.slice(prefix.length, -suffix.length))
    );
  } catch {
    return null;
  }
  const value = payload as { version?: unknown; outcome?: unknown; event?: unknown };
  const event = parseTaskEvent(value.event);
  const outcome =
    value.outcome === 'already_completed' && event?.state === 'completed'
      ? 'already_completed'
      : value.outcome === 'not_active' && event?.state === 'failed'
        ? 'not_active'
        : null;
  if (
    value.version !== 1 ||
    !outcome ||
    !taskId ||
    !event ||
    event.callSessionId !== callSessionId ||
    event.taskId !== taskId ||
    event.cancellable
  ) {
    return null;
  }
  return {
    version: 1,
    outcome,
    event,
    message:
      outcome === 'already_completed'
        ? 'The task has already finished.'
        : 'The task is no longer active.',
    retryable: false,
  };
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
    const conflict =
      response.status === 409
        ? parseCancellationConflict(payload, target, method, callSessionId)
        : null;
    if (conflict) {
      return NextResponse.json(conflict, {
        status: response.status,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    return NextResponse.json(normalizeProxyFailure(response.status, payload), {
      status: response.status,
    });
  }
  return NextResponse.json(payload ?? {}, {
    status: response.status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
