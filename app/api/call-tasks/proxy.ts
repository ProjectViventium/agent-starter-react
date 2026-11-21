/*
 * The single Core adapter of the call page.
 *
 * Every request the call page's server makes to the Viventium Core backend (LibreChat today)
 * goes through `coreRequest` in this file, and every Core path is built by `corePaths`. Nothing
 * else in the page knows Core's origin, the shared server secret, or how a Core request is
 * timed out. Replacing the backend later means replacing this file.
 *
 * The contract is frozen for the LiveKit upgrade: paths, headers and payloads are exactly what
 * Core accepts today, including the per-route differences (which routes also send
 * `X-VIVENTIUM-CALL-SESSION`, which refuse redirects, which send no body).
 *
 * Not Core, and therefore not here: the voice gateway's `/capabilities` (voice-settings route)
 * and the LiveKit server API (token route).
 */
import { NextResponse } from 'next/server';
import { CALL_CAPABILITY_HEADER } from '@/lib/call-browser-capability';
import { normalizeProxyFailure, parseCallIdentifier } from '@/lib/call-proxy';
import { parseTaskEvent } from '@/lib/voice-events';

export const CORE_SECRET_HEADER = 'X-VIVENTIUM-CALL-SECRET';
export const CORE_SESSION_HEADER = 'X-VIVENTIUM-CALL-SESSION';

const DEFAULT_CORE_TIMEOUT_MS = 4_500;

const segment = (value: string) => encodeURIComponent(value);

/** Every Core route the call page uses. */
export const corePaths = {
  /** GET: canonical call session and mode; POST: mode, keep-alive, end. */
  callState: (callSessionId: string) => `/api/viventium/calls/${segment(callSessionId)}/state`,
  dispatchClaim: (callSessionId: string) =>
    `/api/viventium/calls/${segment(callSessionId)}/dispatch/claim`,
  dispatchStatus: (callSessionId: string, claimId: string) =>
    `/api/viventium/calls/${segment(callSessionId)}/dispatch/status?claimId=${segment(claimId)}`,
  dispatchConfirm: (callSessionId: string) =>
    `/api/viventium/calls/${segment(callSessionId)}/dispatch/confirm`,
  browserCapabilityExchange: (callSessionId: string) =>
    `/api/viventium/calls/${segment(callSessionId)}/browser-capability/exchange`,
  voiceSettings: (callSessionId: string) =>
    `/api/viventium/calls/${segment(callSessionId)}/voice-settings`,
  engagementClassify: () => '/api/viventium/voice/engagement/classify',
  /** `cursor` is an already encoded `&key=value…` suffix (or empty). */
  tasks: (callSessionId: string, cursor = '') =>
    `/api/viventium/voice/tasks?callSessionId=${segment(callSessionId)}${cursor}`,
  task: (taskId: string, callSessionId: string) =>
    `/api/viventium/voice/tasks/${segment(taskId)}?callSessionId=${segment(callSessionId)}`,
  taskAction: (taskId: string, action: string) =>
    `/api/viventium/voice/tasks/${segment(taskId)}/${action}`,
  /** `cursor` is an already encoded `&key=value…` suffix (or empty). */
  speakerSegments: (callSessionId: string, cursor = '') =>
    `/api/viventium/voice/speaker-segments?callSessionId=${segment(callSessionId)}${cursor}`,
} as const;

export type CoreRuntime = { origin: string; secret: string; timeoutMs: number };

/** Core connection settings, read on every call so a restart is never needed to pick them up. */
export function coreRuntime(): CoreRuntime | null {
  const origin = process.env.VIVENTIUM_LIBRECHAT_ORIGIN;
  const secret = process.env.VIVENTIUM_CALL_SESSION_SECRET;
  if (!origin || !secret) {
    return null;
  }
  const configuredTimeout = Number(process.env.VIVENTIUM_CALL_PROXY_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(configuredTimeout) && configuredTimeout >= 1 && configuredTimeout <= 60_000
      ? configuredTimeout
      : DEFAULT_CORE_TIMEOUT_MS;
  return { origin, secret, timeoutMs };
}

/** How signed calling is configured: fully, not at all, or (an error) only half. */
export function coreConfigurationState(): 'configured' | 'absent' | 'partial' {
  const hasOrigin = Boolean(process.env.VIVENTIUM_LIBRECHAT_ORIGIN);
  const hasSecret = Boolean(process.env.VIVENTIUM_CALL_SESSION_SECRET);
  return hasOrigin && hasSecret ? 'configured' : hasOrigin || hasSecret ? 'partial' : 'absent';
}

export type CoreBodyReader<T> = (response: Response, signal: AbortSignal) => Promise<T>;

/** JSON body, or `null` when the body is not JSON. A read cut short by the deadline rejects. */
export const readCoreJson: CoreBodyReader<unknown> = (response, signal) =>
  response.json().catch((error: unknown) => {
    if (signal.aborted) {
      throw error;
    }
    return null;
  });

/** Text body parsed as JSON; `null` when empty; `onInvalid(text)` when it is not JSON. */
export function readCoreText(onInvalid: (text: string) => unknown): CoreBodyReader<unknown> {
  return async (response) => {
    const text = await response.text();
    if (!text) {
      return null;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return onInvalid(text);
    }
  };
}

export type CoreRequest<T> = {
  /** A path from `corePaths`. */
  path: string;
  method: 'GET' | 'POST';
  /** The per-call browser capability, forwarded as `X-VIVENTIUM-CALL-CAPABILITY`. */
  browserCapability?: string;
  /** Sent as `X-VIVENTIUM-CALL-SESSION` on the Core routes that expect it. */
  sessionHeader?: string;
  /** Route-specific headers (launch-code exchange). */
  headers?: Record<string, string>;
  /** JSON body. Leave undefined to send no body. */
  body?: unknown;
  /** Set false for the one Core route that takes no JSON content type (launch-code exchange). */
  jsonContentType?: boolean;
  /** Defaults to the shared proxy timeout. Covers the response body read. */
  timeoutMs?: number;
  /** `'error'` on routes that must never follow a redirect with the server secret. */
  redirect?: RequestRedirect;
  /** The browser request's signal: a browser that goes away cancels the Core request. */
  cancelWith?: AbortSignal;
  readBody: CoreBodyReader<T>;
};

export type CoreOutcome<T> =
  | { kind: 'response'; ok: boolean; status: number; payload: T }
  /** Origin or secret missing or unusable. */
  | { kind: 'unconfigured' }
  /** No complete response within the deadline. */
  | { kind: 'timeout' }
  /** Network failure, refused redirect, or the browser cancelled. */
  | { kind: 'unreachable' };

/** One request to Core: adds the server secret, bounds the whole exchange, never caches. */
export async function coreRequest<T>(request: CoreRequest<T>): Promise<CoreOutcome<T>> {
  const runtime = coreRuntime();
  if (!runtime) {
    return { kind: 'unconfigured' };
  }
  let target: string;
  try {
    target = new URL(request.path, runtime.origin).toString();
  } catch {
    return { kind: 'unconfigured' };
  }

  const headers: Record<string, string> = {
    ...(request.jsonContentType === false ? {} : { 'Content-Type': 'application/json' }),
    [CORE_SECRET_HEADER]: runtime.secret,
    ...(request.sessionHeader ? { [CORE_SESSION_HEADER]: request.sessionHeader } : {}),
    ...(request.browserCapability ? { [CALL_CAPABILITY_HEADER]: request.browserCapability } : {}),
    ...(request.headers ?? {}),
  };

  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (request.cancelWith?.aborted) {
    return { kind: 'unreachable' };
  }
  request.cancelWith?.addEventListener('abort', cancel, { once: true });
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.timeoutMs ?? runtime.timeoutMs);

  try {
    const response = await fetch(target, {
      method: request.method,
      headers,
      ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
      cache: 'no-store',
      ...(request.redirect ? { redirect: request.redirect } : {}),
      signal: controller.signal,
    });
    const payload = await request.readBody(response, controller.signal);
    controller.signal.throwIfAborted();
    return { kind: 'response', ok: response.ok, status: response.status, payload };
  } catch {
    return { kind: timedOut ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timeoutId);
    request.cancelWith?.removeEventListener('abort', cancel);
  }
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

function taskRuntimeFailure(message: string, retryable: boolean, status: 503 | 504) {
  return NextResponse.json({ code: 'gateway_down', message, retryable }, { status });
}

/**
 * Task and speaker-segment requests (Core `/api/viventium/voice/*`): answers the browser with
 * Core's JSON on success and with `{ code, message, retryable }` on any failure.
 */
export async function proxyCallTaskRequest(
  path: string,
  method: 'GET' | 'POST',
  callSessionId: string,
  browserCapability: string,
  body?: Record<string, unknown>
) {
  if (!coreRuntime()) {
    return taskRuntimeFailure('The voice task runtime is not configured.', false, 503);
  }
  // Only the path and query are read from this URL; the origin is a placeholder.
  const target = new URL(path, 'http://core.invalid');
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

  const outcome = await coreRequest({
    path,
    method,
    browserCapability,
    sessionHeader: callSessionId,
    ...(method === 'POST' ? { body: body ?? {} } : {}),
    readBody: readCoreJson,
  });

  if (outcome.kind === 'unconfigured') {
    return taskRuntimeFailure('The voice task runtime is not configured.', false, 503);
  }
  if (outcome.kind === 'timeout') {
    return taskRuntimeFailure(
      'The voice task runtime did not respond before the request timed out.',
      true,
      504
    );
  }
  if (outcome.kind === 'unreachable') {
    return taskRuntimeFailure('Viventium could not reach the voice task runtime.', true, 503);
  }

  if (!outcome.ok) {
    const conflict =
      outcome.status === 409
        ? parseCancellationConflict(outcome.payload, target, method, callSessionId)
        : null;
    if (conflict) {
      return NextResponse.json(conflict, {
        status: outcome.status,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    return NextResponse.json(normalizeProxyFailure(outcome.status, outcome.payload), {
      status: outcome.status,
    });
  }
  return NextResponse.json(outcome.payload ?? {}, {
    status: outcome.status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
