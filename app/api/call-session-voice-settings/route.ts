/* VIVENTIUM START
 * Purpose: Viventium agent-starter customization.
 * Feature: Call-session voice-settings proxy for pre-call STT/TTS routing
 *
 * Why:
 * - The modern playground runs on a separate origin from LibreChat.
 * - The browser should not hold the shared call-session secret directly.
 * - This route proxies voice-settings reads/writes using the server-side secret.
 * VIVENTIUM END */
import { NextResponse } from 'next/server';

const VIVENTIUM_LIBRECHAT_ORIGIN = process.env.VIVENTIUM_LIBRECHAT_ORIGIN;
const VIVENTIUM_CALL_SESSION_SECRET = process.env.VIVENTIUM_CALL_SESSION_SECRET;
const VOICE_GATEWAY_HOST = process.env.VOICE_GATEWAY_HOST || '127.0.0.1';
const VOICE_GATEWAY_PORT =
  process.env.VIVENTIUM_VOICE_GATEWAY_HEALTH_PORT || process.env.VOICE_GATEWAY_PORT || '8000';
const VOICE_SETTINGS_PROXY_TIMEOUT_MS = 4500;

function getVoiceSettingsProxyTimeoutMs() {
  const parsed = Number(process.env.VIVENTIUM_VOICE_SETTINGS_PROXY_TIMEOUT_MS || '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : VOICE_SETTINGS_PROXY_TIMEOUT_MS;
}

function buildTargetUrl(callSessionId: string): URL {
  if (!VIVENTIUM_LIBRECHAT_ORIGIN) {
    throw new Error('VIVENTIUM_LIBRECHAT_ORIGIN is not configured');
  }
  return new URL(
    `/api/viventium/calls/${encodeURIComponent(callSessionId)}/voice-settings`,
    VIVENTIUM_LIBRECHAT_ORIGIN
  );
}

function getSharedHeaders(): HeadersInit {
  if (!VIVENTIUM_CALL_SESSION_SECRET) {
    throw new Error('VIVENTIUM_CALL_SESSION_SECRET is not configured');
  }
  return {
    'Content-Type': 'application/json',
    'X-VIVENTIUM-CALL-SECRET': VIVENTIUM_CALL_SESSION_SECRET,
  };
}

async function proxyVoiceSettingsRequest(
  url: URL,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>
) {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, getVoiceSettingsProxyTimeoutMs());

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method,
      headers: getSharedHeaders(),
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) {
      return {
        status: 504,
        payload: {
          message:
            'Viventium could not load voice settings before the voice runtime responded. You can still start the call; retry voice settings after the runtime is ready.',
        },
      };
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text };
    }
  }

  return {
    status: response.status,
    payload,
  };
}

function getVoiceGatewayOrigin() {
  const normalizedHost = VOICE_GATEWAY_HOST === '0.0.0.0' ? '127.0.0.1' : VOICE_GATEWAY_HOST;
  return `http://${normalizedHost}:${VOICE_GATEWAY_PORT}`;
}

async function fetchSelectionVoiceRoute() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);

  try {
    const response = await fetch(`${getVoiceGatewayOrigin()}/capabilities`, {
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

function buildResponse(
  status: number,
  payload: unknown,
  selectionVoiceRoute: Record<string, unknown> | null
) {
  const body: Record<string, unknown> =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? { ...(payload as Record<string, unknown>) }
      : payload == null
        ? {}
        : { message: String(payload) };

  if (selectionVoiceRoute) {
    body.selectionVoiceRoute = selectionVoiceRoute;
  }

  return NextResponse.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const callSessionId = (searchParams.get('callSessionId') || '').trim();
    if (!callSessionId) {
      return NextResponse.json({ message: 'callSessionId is required' }, { status: 400 });
    }
    const [proxyResult, selectionVoiceRoute] = await Promise.all([
      proxyVoiceSettingsRequest(buildTargetUrl(callSessionId), 'GET'),
      fetchSelectionVoiceRoute(),
    ]);
    return buildResponse(proxyResult.status, proxyResult.payload, selectionVoiceRoute);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      callSessionId?: unknown;
      requestedVoiceRoute?: unknown;
    };
    const callSessionId = typeof body.callSessionId === 'string' ? body.callSessionId.trim() : '';
    if (!callSessionId) {
      return NextResponse.json({ message: 'callSessionId is required' }, { status: 400 });
    }

    const [proxyResult, selectionVoiceRoute] = await Promise.all([
      proxyVoiceSettingsRequest(buildTargetUrl(callSessionId), 'POST', {
        requestedVoiceRoute: body.requestedVoiceRoute,
      }),
      fetchSelectionVoiceRoute(),
    ]);

    return buildResponse(proxyResult.status, proxyResult.payload, selectionVoiceRoute);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ message }, { status: 500 });
  }
}
