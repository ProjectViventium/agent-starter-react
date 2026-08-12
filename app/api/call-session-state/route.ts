/* VIVENTIUM START
 * Purpose: Viventium agent-starter customization.
 * Feature: Call session state proxy for Wing Mode + keepalive
 *
 * Why:
 * - The modern playground runs on a separate origin from LibreChat.
 * - The browser should not hold the shared call-session secret directly.
 * - This route proxies call-session state reads/writes to LibreChat using the server-side secret.
 * VIVENTIUM END */
import { NextResponse } from 'next/server';
import {
  CALL_CAPABILITY_HEADER,
  readRequestCallBrowserCapability,
} from '@/lib/call-browser-capability';
import { normalizeProxyFailure, parseCallIdentifier } from '@/lib/call-proxy';

function buildTargetUrl(callSessionId: string): URL {
  const origin = process.env.VIVENTIUM_LIBRECHAT_ORIGIN;
  if (!origin) {
    throw new Error('VIVENTIUM_LIBRECHAT_ORIGIN is not configured');
  }
  return new URL(`/api/viventium/calls/${encodeURIComponent(callSessionId)}/state`, origin);
}

function getSharedHeaders(browserCapability: string): HeadersInit {
  const secret = process.env.VIVENTIUM_CALL_SESSION_SECRET;
  if (!secret) {
    throw new Error('VIVENTIUM_CALL_SESSION_SECRET is not configured');
  }
  return {
    'Content-Type': 'application/json',
    'X-VIVENTIUM-CALL-SECRET': secret,
    [CALL_CAPABILITY_HEADER]: browserCapability,
  };
}

async function proxyStateRequest(
  url: URL,
  method: 'GET' | 'POST',
  browserCapability: string,
  body?: Record<string, unknown>
) {
  const configuredTimeout = Number(process.env.VIVENTIUM_CALL_PROXY_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(configuredTimeout) && configuredTimeout >= 1 && configuredTimeout <= 60_000
      ? configuredTimeout
      : 4_500;
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method,
      headers: getSharedHeaders(browserCapability),
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) {
      return NextResponse.json(
        {
          code: 'gateway_down',
          message: 'The call state runtime did not respond before the request timed out.',
          retryable: true,
        },
        { status: 504 }
      );
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

  if (payload && typeof payload === 'object') {
    const normalized = payload as {
      wingModeEnabled?: unknown;
      shadowModeEnabled?: unknown;
      listenOnlyModeEnabled?: unknown;
      mode?: unknown;
    };
    if (
      typeof normalized.wingModeEnabled !== 'boolean' &&
      typeof normalized.shadowModeEnabled === 'boolean'
    ) {
      normalized.wingModeEnabled = normalized.shadowModeEnabled;
    }
    if (
      typeof normalized.shadowModeEnabled !== 'boolean' &&
      typeof normalized.wingModeEnabled === 'boolean'
    ) {
      normalized.shadowModeEnabled = normalized.wingModeEnabled;
    }
    if (normalized.listenOnlyModeEnabled === true) {
      normalized.wingModeEnabled = false;
      normalized.shadowModeEnabled = false;
    }
  }

  return NextResponse.json(
    response.ok ? (payload ?? {}) : normalizeProxyFailure(response.status, payload),
    {
      status: response.status,
      headers: {
        'Cache-Control': 'no-store',
      },
    }
  );
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const callSessionId = parseCallIdentifier(searchParams.get('callSessionId'));
    if (!callSessionId) {
      return NextResponse.json(
        { code: 'unknown', message: 'A valid callSessionId is required.', retryable: false },
        { status: 400 }
      );
    }
    const browserCapability = readRequestCallBrowserCapability(req);
    if (!browserCapability) {
      return NextResponse.json(
        {
          code: 'auth_expired',
          message: 'The call capability is missing or invalid.',
          retryable: false,
        },
        { status: 401 }
      );
    }
    return await proxyStateRequest(buildTargetUrl(callSessionId), 'GET', browserCapability);
  } catch {
    return NextResponse.json(
      {
        code: 'gateway_down',
        message: 'Viventium could not reach the call state runtime.',
        retryable: true,
      },
      { status: 503 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      callSessionId?: unknown;
      wingModeEnabled?: unknown;
      shadowModeEnabled?: unknown;
      listenOnlyModeEnabled?: unknown;
      mode?: unknown;
      touch?: unknown;
      status?: unknown;
    };
    const callSessionId = parseCallIdentifier(body.callSessionId);
    if (!callSessionId) {
      return NextResponse.json(
        { code: 'unknown', message: 'A valid callSessionId is required.', retryable: false },
        { status: 400 }
      );
    }
    const browserCapability = readRequestCallBrowserCapability(req);
    if (!browserCapability) {
      return NextResponse.json(
        {
          code: 'auth_expired',
          message: 'The call capability is missing or invalid.',
          retryable: false,
        },
        { status: 401 }
      );
    }
    if (body.status !== undefined && body.status !== 'ended') {
      return NextResponse.json(
        { code: 'unknown', message: 'The call status transition is invalid.', retryable: false },
        { status: 400 }
      );
    }

    const proxyBody: Record<string, unknown> = {
      touch: body.status === 'ended' ? false : body.touch !== false,
    };
    if (body.status === 'ended') {
      proxyBody.status = 'ended';
    }
    if (body.mode === 'call' || body.mode === 'wing' || body.mode === 'listen_only') {
      proxyBody.mode = body.mode;
    }
    if (typeof body.wingModeEnabled === 'boolean') {
      proxyBody.wingModeEnabled = body.wingModeEnabled;
    } else if (typeof body.shadowModeEnabled === 'boolean') {
      proxyBody.shadowModeEnabled = body.shadowModeEnabled;
    }
    if (typeof body.listenOnlyModeEnabled === 'boolean') {
      proxyBody.listenOnlyModeEnabled = body.listenOnlyModeEnabled;
    }

    return await proxyStateRequest(
      buildTargetUrl(callSessionId),
      'POST',
      browserCapability,
      proxyBody
    );
  } catch {
    return NextResponse.json(
      {
        code: 'gateway_down',
        message: 'Viventium could not reach the call state runtime.',
        retryable: true,
      },
      { status: 503 }
    );
  }
}
