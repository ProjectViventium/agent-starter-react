/* VIVENTIUM START
 * Purpose: Proxy explicit End Call intent without exposing the shared call-session secret.
 * Refresh and network disconnects do not call this route, so they do not request native provider
 * cancellation. Successful stream reattachment is verified separately.
 * VIVENTIUM END */
import { NextResponse } from 'next/server';

const VIVENTIUM_LIBRECHAT_ORIGIN = process.env.VIVENTIUM_LIBRECHAT_ORIGIN;
const VIVENTIUM_CALL_SESSION_SECRET = process.env.VIVENTIUM_CALL_SESSION_SECRET;

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { callSessionId?: unknown };
    const callSessionId = typeof body.callSessionId === 'string' ? body.callSessionId.trim() : '';
    if (!callSessionId) {
      return NextResponse.json({ message: 'callSessionId is required' }, { status: 400 });
    }
    if (!VIVENTIUM_LIBRECHAT_ORIGIN || !VIVENTIUM_CALL_SESSION_SECRET) {
      throw new Error('Viventium call-session proxy is not configured');
    }

    const target = new URL(
      `/api/viventium/calls/${encodeURIComponent(callSessionId)}/end`,
      VIVENTIUM_LIBRECHAT_ORIGIN
    );
    const response = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-VIVENTIUM-CALL-SECRET': VIVENTIUM_CALL_SESSION_SECRET,
      },
      body: '{}',
      cache: 'no-store',
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

    return NextResponse.json(payload, {
      status: response.status,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ message: 'Call cancellation is unavailable' }, { status: 500 });
  }
}
