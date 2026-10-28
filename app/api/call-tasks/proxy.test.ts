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
  const terminalEvent = (patch = {}) => ({
    version: 1,
    eventId: 'terminal-event',
    sequence: 5,
    emittedAt: '2026-10-05T12:00:00.000Z',
    callSessionId: 'call-1',
    taskId: 'task-1',
    type: 'state',
    state: 'completed',
    cancellable: false,
    retryable: false,
    ...patch,
  });
  const upstream = (payload: unknown, status = 409) => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'server-secret';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
  };
  it.each([
    ['already_completed', 'completed', 'The task has already finished.'],
    ['not_active', 'failed', 'The task is no longer active.'],
  ])(
    'keeps the bound %s cancellation race as 409 with canonical terminal state',
    async (outcome, state, message) => {
      const event = terminalEvent({ state });
      upstream({
        version: 1,
        outcome,
        event,
        task: { privateCanary: 'omit-me' },
        privateCanary: 'omit-me',
      });
      const response = await proxyCallTaskRequest(
        '/api/viventium/voice/tasks/task-1/cancel',
        'POST',
        'call-1',
        'A'.repeat(43),
        { callSessionId: 'call-1' }
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        version: 1,
        outcome,
        event,
        message,
        retryable: false,
      });
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
  );
  it.each([
    { event: terminalEvent({ callSessionId: 'foreign-call' }) },
    { event: terminalEvent({ taskId: 'foreign-task' }) },
    { event: terminalEvent({ taskId: 'child-task', parentTaskId: 'task-1' }) },
    { event: terminalEvent({ version: 2 }) },
    { event: terminalEvent({ state: 'running' }) },
    { event: terminalEvent({ cancellable: true }) },
    { event: null },
    { version: 2 },
    { outcome: 'not_active' },
    { outcome: 'cancelled_confirmed' },
  ])('fails closed on an unbound or invalid terminal conflict %p', async (patch) => {
    upstream({ version: 1, outcome: 'already_completed', event: terminalEvent(), ...patch });
    const response = await proxyCallTaskRequest(
      '/api/viventium/voice/tasks/task-1/cancel',
      'POST',
      'call-1',
      'A'.repeat(43),
      { callSessionId: 'call-1' }
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: 'unknown',
      message: 'The call request failed.',
      retryable: false,
    });
  });
  it.each([401, 503])(
    'retains error sanitization for HTTP%s despite a terminal-looking payload',
    async (status) => {
      upstream(
        {
          version: 1,
          outcome: 'already_completed',
          event: terminalEvent(),
          task: { privateCanary: 'omit-me' },
        },
        status
      );
      const response = await proxyCallTaskRequest(
        '/api/viventium/voice/tasks/task-1/cancel',
        'POST',
        'call-1',
        'A'.repeat(43),
        { callSessionId: 'call-1' }
      );
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({
        code: status === 401 ? 'auth_expired' : 'gateway_down',
        message: 'The call request failed.',
        retryable: false,
      });
    }
  );
  it.each([
    ['/api/viventium/voice/tasks/task-1/retry', 'POST'],
    ['/api/viventium/voice/tasks/task-1/input', 'POST'],
    ['/api/viventium/voice/tasks/task-1/cancel', 'GET'],
    ['/api/viventium/voice/tasks/../task-1/cancel', 'POST'],
    ['/api/viventium/voice/tasks/task-1%2Fother/cancel', 'POST'],
  ] as const)('does not reinterpret another request path or method %s', async (path, method) => {
    upstream({ version: 1, outcome: 'already_completed', event: terminalEvent() });
    const response = await proxyCallTaskRequest(path, method, 'call-1', 'A'.repeat(43), {
      callSessionId: 'call-1',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: 'unknown',
      message: 'The call request failed.',
      retryable: false,
    });
  });
});

describe('exact completed speech Stop BFF carrier', () => {
  it('forwards bounded ref over the existing authenticated task action route', async () => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'server-secret';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ version: 1 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { POST } = await import('@/app/api/call-tasks/[taskId]/[action]/route');
    const response = await POST(
      new Request('https://ui.example.com/api/call-tasks/task-1/cancel', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-VIVENTIUM-CALL-CAPABILITY': 'A'.repeat(43),
        },
        body: JSON.stringify({ callSessionId: 'call-1', presentationRef: 'speech-1' }),
      }),
      { params: Promise.resolve({ taskId: 'task-1', action: 'cancel' }) }
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      callSessionId: 'call-1',
      presentationRef: 'speech-1',
    });
  });
});

describe('call task response body deadline', () => {
  const configure = () => {
    vi.useFakeTimers();
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'synthetic-server-secret';
    process.env.VIVENTIUM_CALL_PROXY_TIMEOUT_MS = '10';
  };
  const request = () =>
    proxyCallTaskRequest(
      '/api/viventium/voice/tasks?callSessionId=call-1',
      'GET',
      'call-1',
      'A'.repeat(43)
    );

  it.each([200, 410])('bounds a stalled HTTP%s body after headers', async (status) => {
    configure();
    const observation: { signal?: AbortSignal } = {};
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
      observation.signal = init?.signal ?? undefined;
      return {
        status,
        ok: status < 400,
        json: () =>
          new Promise<unknown>((_resolve, reject) => {
            observation.signal?.addEventListener(
              'abort',
              () => {
                const error = new Error('Aborted');
                error.name = 'AbortError';
                reject(error);
              },
              { once: true }
            );
          }),
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    let settled = false;
    const pending = request().then((response) => {
      settled = true;
      return response;
    });
    await vi.advanceTimersByTimeAsync(11);
    expect(settled).toBe(true);
    const response = await pending;
    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({ code: 'gateway_down', retryable: true });
    expect(observation.signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [200, JSON.stringify({ version: 1, events: [] }), { version: 1, events: [] }],
    [200, 'not JSON', {}],
    [
      410,
      JSON.stringify({ code: 'auth_expired', message: 'This call has ended.', retryable: false }),
      { code: 'auth_expired', message: 'This call has ended.', retryable: false },
    ],
  ] as const)(
    'keeps completed HTTP%s payloads and clears their deadline',
    async (status, body, expected) => {
      configure();
      const observation: { signal?: AbortSignal } = {};
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: URL, init?: RequestInit) => {
          observation.signal = init?.signal ?? undefined;
          return new Response(body, { status });
        })
      );
      const response = await request();
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual(expected);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(11);
      expect(observation.signal?.aborted).toBe(false);
    }
  );
});
