/*
 * Call state proxy (CP-APP-019): read the call's mode and status, switch mode
 * (Call / Wing / Listen-Only), keep the call session alive, and mark it ended.
 * The browser never holds the shared call-session secret; Core is reached through the adapter.
 */
import { NextResponse } from 'next/server';
import { corePaths, coreRequest, readCoreText } from '@/app/api/call-tasks/proxy';
import { readRequestCallBrowserCapability } from '@/lib/call-browser-capability';
import { normalizeProxyFailure, parseCallIdentifier } from '@/lib/call-proxy';

const CALL_MODES = new Set(['call', 'wing', 'listen_only']);
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function stateRuntimeFailure(message: string, status: 503 | 504) {
  return NextResponse.json({ code: 'gateway_down', message, retryable: true }, { status });
}

function invalidRequest(message: string) {
  return NextResponse.json({ code: 'unknown', message, retryable: false }, { status: 400 });
}

function missingCapability() {
  return NextResponse.json(
    {
      code: 'auth_expired',
      message: 'The call capability is missing or invalid.',
      retryable: false,
    },
    { status: 401 }
  );
}

/**
 * The page reads one field, `mode`. Core sends it on every state response; if an older session
 * record answers with only the legacy booleans, `mode` is derived here, in one place.
 */
function withMode(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }
  const state = payload as Record<string, unknown>;
  if (typeof state.mode === 'string' && CALL_MODES.has(state.mode)) {
    return state;
  }
  const wing =
    typeof state.wingModeEnabled === 'boolean' ? state.wingModeEnabled : state.shadowModeEnabled;
  if (typeof state.listenOnlyModeEnabled !== 'boolean' && typeof wing !== 'boolean') {
    return state;
  }
  return {
    ...state,
    mode: state.listenOnlyModeEnabled === true ? 'listen_only' : wing === true ? 'wing' : 'call',
  };
}

async function proxyStateRequest(
  callSessionId: string,
  method: 'GET' | 'POST',
  browserCapability: string,
  body?: Record<string, unknown>
) {
  const outcome = await coreRequest({
    path: corePaths.callState(callSessionId),
    method,
    browserCapability,
    ...(method === 'POST' ? { body: body ?? {} } : {}),
    readBody: readCoreText((text) => ({ message: text })),
  });
  if (outcome.kind === 'timeout') {
    return stateRuntimeFailure(
      'The call state runtime did not respond before the request timed out.',
      504
    );
  }
  if (outcome.kind !== 'response') {
    return stateRuntimeFailure('Viventium could not reach the call state runtime.', 503);
  }
  return NextResponse.json(
    outcome.ok
      ? (withMode(outcome.payload) ?? {})
      : normalizeProxyFailure(outcome.status, outcome.payload),
    { status: outcome.status, headers: NO_STORE }
  );
}

export async function GET(req: Request) {
  const callSessionId = parseCallIdentifier(new URL(req.url).searchParams.get('callSessionId'));
  if (!callSessionId) {
    return invalidRequest('A valid callSessionId is required.');
  }
  const browserCapability = readRequestCallBrowserCapability(req);
  if (!browserCapability) {
    return missingCapability();
  }
  return proxyStateRequest(callSessionId, 'GET', browserCapability);
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    callSessionId?: unknown;
    mode?: unknown;
    touch?: unknown;
    status?: unknown;
  } | null;
  const callSessionId = parseCallIdentifier(body?.callSessionId);
  if (!body || !callSessionId) {
    return invalidRequest('A valid callSessionId is required.');
  }
  const browserCapability = readRequestCallBrowserCapability(req);
  if (!browserCapability) {
    return missingCapability();
  }
  if (body.status !== undefined && body.status !== 'ended') {
    return invalidRequest('The call status transition is invalid.');
  }

  // The only status a browser may set is "ended"; ending never extends the session.
  const proxyBody: Record<string, unknown> = {
    touch: body.status === 'ended' ? false : body.touch !== false,
  };
  if (body.status === 'ended') {
    proxyBody.status = 'ended';
  }
  if (typeof body.mode === 'string' && CALL_MODES.has(body.mode)) {
    proxyBody.mode = body.mode;
  }
  return proxyStateRequest(callSessionId, 'POST', browserCapability, proxyBody);
}
