import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.VIVENTIUM_LIBRECHAT_ORIGIN;
  delete process.env.VIVENTIUM_CALL_SESSION_SECRET;
  delete process.env.VIVENTIUM_CALL_PROXY_TIMEOUT_MS;
  vi.resetModules();
});

describe('call session state proxy', () => {
  it('bounds an unreachable state runtime with a retryable classified timeout', async () => {
    vi.useFakeTimers();
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'server-secret';
    process.env.VIVENTIUM_CALL_PROXY_TIMEOUT_MS = '10';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError'))
            );
          })
      )
    );
    const { GET } = await import('@/app/api/call-session-state/route');

    const pending = GET(
      new Request('https://playground.example.com/api/call-session-state?callSessionId=call-1', {
        headers: { 'X-VIVENTIUM-CALL-CAPABILITY': 'A'.repeat(43) },
      })
    );
    await vi.advanceTimersByTimeAsync(11);
    const response = await pending;

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({
      code: 'gateway_down',
      retryable: true,
    });
  });
});
