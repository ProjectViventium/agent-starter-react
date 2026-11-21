/*
 * Voice settings proxy (CP-APP-021): read and save the speech-to-text and voice choice of one
 * call, and attach the voice gateway's own provider catalog as `selectionVoiceRoute` (the single
 * source of provider, model and voice names for the picker).
 */
import { NextResponse } from 'next/server';
import { corePaths, coreRequest, coreRuntime, readCoreText } from '@/app/api/call-tasks/proxy';
import { readRequestCallBrowserCapability } from '@/lib/call-browser-capability';
import { normalizeProxyFailure, parseCallIdentifier } from '@/lib/call-proxy';

const GATEWAY_CAPABILITIES_TIMEOUT_MS = 1_500;
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function voiceGatewayOrigin() {
  const host = process.env.VOICE_GATEWAY_HOST || '127.0.0.1';
  const port =
    process.env.VIVENTIUM_VOICE_GATEWAY_HEALTH_PORT || process.env.VOICE_GATEWAY_PORT || '8000';
  return `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
}

/** The gateway's provider catalog. Not a Core call; `null` when the gateway does not answer. */
async function fetchSelectionVoiceRoute(): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GATEWAY_CAPABILITIES_TIMEOUT_MS);
  try {
    const response = await fetch(`${voiceGatewayOrigin()}/capabilities`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function settingsRuntimeFailure(message: string, status: 503 | 504) {
  return NextResponse.json(
    { code: 'gateway_down', message, retryable: true },
    { status, headers: NO_STORE }
  );
}

async function proxyVoiceSettings(
  callSessionId: string,
  method: 'GET' | 'POST',
  browserCapability: string,
  body?: Record<string, unknown>
) {
  if (!coreRuntime()) {
    return settingsRuntimeFailure('Viventium could not reach the voice settings runtime.', 503);
  }
  const [outcome, selectionVoiceRoute] = await Promise.all([
    coreRequest({
      path: corePaths.voiceSettings(callSessionId),
      method,
      browserCapability,
      ...(method === 'POST' ? { body: body ?? {} } : {}),
      readBody: readCoreText((text) => ({ message: text })),
    }),
    fetchSelectionVoiceRoute(),
  ]);
  if (outcome.kind === 'timeout') {
    return settingsRuntimeFailure(
      'Viventium could not load voice settings before the voice runtime responded.',
      504
    );
  }
  if (outcome.kind !== 'response') {
    return settingsRuntimeFailure('Viventium could not reach the voice settings runtime.', 503);
  }

  const payload = outcome.payload;
  const responseBody: Record<string, unknown> =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? { ...(payload as Record<string, unknown>) }
      : payload == null
        ? {}
        : { message: String(payload) };
  if (outcome.status >= 400) {
    // Errors never carry the provider catalog.
    return NextResponse.json(normalizeProxyFailure(outcome.status, responseBody), {
      status: outcome.status,
      headers: NO_STORE,
    });
  }
  if (selectionVoiceRoute) {
    responseBody.selectionVoiceRoute = selectionVoiceRoute;
  }
  return NextResponse.json(responseBody, { status: outcome.status, headers: NO_STORE });
}

function invalidCallSession() {
  return NextResponse.json(
    { code: 'unknown', message: 'A valid callSessionId is required.', retryable: false },
    { status: 400 }
  );
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

export async function GET(req: Request) {
  const callSessionId = parseCallIdentifier(new URL(req.url).searchParams.get('callSessionId'));
  if (!callSessionId) {
    return invalidCallSession();
  }
  const browserCapability = readRequestCallBrowserCapability(req);
  if (!browserCapability) {
    return missingCapability();
  }
  return proxyVoiceSettings(callSessionId, 'GET', browserCapability);
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    callSessionId?: unknown;
    requestedVoiceRoute?: unknown;
  } | null;
  const callSessionId = parseCallIdentifier(body?.callSessionId);
  if (!body || !callSessionId) {
    return invalidCallSession();
  }
  const browserCapability = readRequestCallBrowserCapability(req);
  if (!browserCapability) {
    return missingCapability();
  }
  return proxyVoiceSettings(callSessionId, 'POST', browserCapability, {
    requestedVoiceRoute: body.requestedVoiceRoute,
  });
}
