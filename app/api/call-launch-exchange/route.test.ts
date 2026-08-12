import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.VIVENTIUM_LIBRECHAT_ORIGIN;
  delete process.env.VIVENTIUM_CALL_SESSION_SECRET;
  vi.resetModules();
});

describe('one-time call launch exchange BFF', () => {
  it('forwards the launch bearer only in its dedicated header and never caches it', async () => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://chat.example.test';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'server-secret';
    const upstream = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.body).toBeUndefined();
      const headers = new Headers(init?.headers);
      expect(headers.get('X-VIVENTIUM-CALL-SECRET')).toBe('server-secret');
      expect(headers.get('X-VIVENTIUM-CALL-LAUNCH')).toBe('L'.repeat(43));
      expect(headers.get('X-VIVENTIUM-CALL-LAUNCH-IDEMPOTENCY')).toBe('I'.repeat(43));
      return new Response(
        JSON.stringify({
          version: 1,
          callSessionId: 'call-1',
          browserCapability: 'B'.repeat(43),
          expiresAt: '2026-08-09T22:00:00.000Z',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', upstream);
    const { POST } = await import('@/app/api/call-launch-exchange/route');
    const response = await POST(
      new Request('https://voice.example.test/api/call-launch-exchange?callSessionId=call-1', {
        method: 'POST',
        headers: {
          'X-VIVENTIUM-CALL-LAUNCH': 'L'.repeat(43),
          'X-VIVENTIUM-CALL-LAUNCH-IDEMPOTENCY': 'I'.repeat(43),
        },
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store, private');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    await expect(response.json()).resolves.toEqual({
      version: 1,
      callSessionId: 'call-1',
      browserCapability: 'B'.repeat(43),
      expiresAt: '2026-08-09T22:00:00.000Z',
    });
    expect(upstream).toHaveBeenCalledWith(
      'https://chat.example.test/api/viventium/calls/call-1/browser-capability/exchange',
      expect.objectContaining({ method: 'POST', cache: 'no-store', redirect: 'error' })
    );
    expect(upstream.mock.calls[0]?.[0]).not.toContain('L'.repeat(43));
  });

  it.each([
    ['missing', ''],
    ['malformed', 'short'],
  ])('rejects a %s bearer before contacting LibreChat', async (_label, launch) => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://chat.example.test';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'server-secret';
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const { POST } = await import('@/app/api/call-launch-exchange/route');
    const headers = launch
      ? {
          'X-VIVENTIUM-CALL-LAUNCH': launch,
          'X-VIVENTIUM-CALL-LAUNCH-IDEMPOTENCY': 'I'.repeat(43),
        }
      : undefined;
    const response = await POST(
      new Request('https://voice.example.test/api/call-launch-exchange?callSessionId=call-1', {
        method: 'POST',
        headers,
      })
    );
    expect(response.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('passes through replay, expiry, and cross-session rejection without leaking the bearer', async () => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://chat.example.test';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'server-secret';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: 'auth_expired',
              message: 'This call link expired or was already used.',
              retryable: false,
            }),
            { status: 410, headers: { 'Content-Type': 'application/json' } }
          )
      )
    );
    const { POST } = await import('@/app/api/call-launch-exchange/route');
    const response = await POST(
      new Request('https://voice.example.test/api/call-launch-exchange?callSessionId=other-call', {
        method: 'POST',
        headers: {
          'X-VIVENTIUM-CALL-LAUNCH': 'L'.repeat(43),
          'X-VIVENTIUM-CALL-LAUNCH-IDEMPOTENCY': 'I'.repeat(43),
        },
      })
    );
    expect(response.status).toBe(410);
    const body = await response.text();
    expect(body).not.toContain('L'.repeat(43));
  });
});
