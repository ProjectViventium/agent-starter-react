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

const VIVENTIUM_LIBRECHAT_ORIGIN = process.env.VIVENTIUM_LIBRECHAT_ORIGIN;
const VIVENTIUM_CALL_SESSION_SECRET = process.env.VIVENTIUM_CALL_SESSION_SECRET;

function buildTargetUrl(callSessionId: string): URL {
  if (!VIVENTIUM_LIBRECHAT_ORIGIN) {
    throw new Error('VIVENTIUM_LIBRECHAT_ORIGIN is not configured');
  }
  return new URL(
    `/api/viventium/calls/${encodeURIComponent(callSessionId)}/state`,
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

async function proxyStateRequest(url: URL, method: 'GET' | 'POST', body?: Record<string, unknown>) {
  const response = await fetch(url.toString(), {
    method,
    headers: getSharedHeaders(),
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    cache: 'no-store',
  });

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
  }

  return NextResponse.json(payload ?? {}, {
    status: response.status,
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
    return await proxyStateRequest(buildTargetUrl(callSessionId), 'GET');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      callSessionId?: unknown;
      wingModeEnabled?: unknown;
      shadowModeEnabled?: unknown;
      touch?: unknown;
    };
    const callSessionId = typeof body.callSessionId === 'string' ? body.callSessionId.trim() : '';
    if (!callSessionId) {
      return NextResponse.json({ message: 'callSessionId is required' }, { status: 400 });
    }

    const proxyBody: Record<string, unknown> = {
      touch: body.touch !== false,
    };
    if (typeof body.wingModeEnabled === 'boolean') {
      proxyBody.wingModeEnabled = body.wingModeEnabled;
    } else if (typeof body.shadowModeEnabled === 'boolean') {
      proxyBody.shadowModeEnabled = body.shadowModeEnabled;
    }

    return await proxyStateRequest(buildTargetUrl(callSessionId), 'POST', proxyBody);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ message }, { status: 500 });
  }
}
