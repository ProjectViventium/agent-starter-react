import { afterEach, describe, expect, it, vi } from 'vitest';
import { proxyCallTaskRequest } from '@/app/api/call-tasks/proxy';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.VIVENTIUM_LIBRECHAT_ORIGIN;
  delete process.env.VIVENTIUM_CALL_SESSION_SECRET;
  delete process.env.VIVENTIUM_CALL_PROXY_TIMEOUT_MS;
  vi.useRealTimers();
});

describe('call task server proxy', () => {
  it('injects the secret and exact authenticated call session', async () => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'server-secret';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ version: 1, events: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await proxyCallTaskRequest(
      '/api/viventium/voice/tasks?callSessionId=call-1',
      'GET',
      'call-1',
      'A'.repeat(43)
    );

    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://librechat.example.com/api/viventium/voice/tasks?callSessionId=call-1'),
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-VIVENTIUM-CALL-SECRET': 'server-secret',
          'X-VIVENTIUM-CALL-SESSION': 'call-1',
          'X-VIVENTIUM-CALL-CAPABILITY': 'A'.repeat(43),
        }),
      })
    );
  });

  it('fails closed when query/body and authenticated session differ', async () => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'server-secret';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const queryMismatch = await proxyCallTaskRequest(
      '/api/viventium/voice/tasks?callSessionId=call-b',
      'GET',
      'call-a',
      'A'.repeat(43)
    );
    const bodyMismatch = await proxyCallTaskRequest(
      '/api/viventium/voice/tasks/task-1/cancel',
      'POST',
      'call-a',
      'A'.repeat(43),
      { callSessionId: 'call-b' }
    );

    expect(queryMismatch.status).toBe(400);
    expect(bodyMismatch.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bounds an unreachable upstream and returns a retryable classified timeout', async () => {
    vi.useFakeTimers();
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'server-secret';
    process.env.VIVENTIUM_CALL_PROXY_TIMEOUT_MS = '10';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError'))
            );
          })
      )
    );

    const pending = proxyCallTaskRequest(
      '/api/viventium/voice/tasks?callSessionId=call-1',
      'GET',
      'call-1',
      'A'.repeat(43)
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
