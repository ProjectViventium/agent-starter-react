import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useCallSessionState } from '@/hooks/useCallSessionState';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useCallSessionState response body deadlines', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function stalledJsonResponse(signal: AbortSignal, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: vi.fn(
        () =>
          new Promise<unknown>((_resolve, reject) => {
            const abort = () => reject(new DOMException('Aborted', 'AbortError'));
            if (signal.aborted) {
              abort();
            } else {
              signal.addEventListener('abort', abort, { once: true });
            }
          })
      ),
    } as unknown as Response;
  }

  function listeningState(callSessionId: string) {
    return {
      version: 1,
      callSessionId,
      mode: 'call',
      status: 'listening',
      revision: 1,
      updatedAt: '2026-08-09T12:00:00.000Z',
    };
  }

  it.each([200, 401])('bounds a stalled JSON body after %s headers', async (status) => {
    vi.useFakeTimers();
    const observed: { signal?: AbortSignal } = {};
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      observed.signal = init?.signal as AbortSignal;
      return Promise.resolve(stalledJsonResponse(observed.signal, status));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result, unmount } = renderHook(() => useCallSessionState('call-body-stall', false));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(observed.signal?.aborted).toBe(true);
    expect(result.current.callStateIssue?.kind).toBe('gateway_down');
    expect(result.current.callStateRetryable).toBe(true);
    expect(result.current.authoritativeStatus).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases a stalled keepalive so the next existing interval can recover', async () => {
    vi.useFakeTimers();
    const state = listeningState('call-keepalive-body');
    const observed: { signal?: AbortSignal } = {};
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(state))
      .mockImplementationOnce((_url: string, init?: RequestInit) => {
        observed.signal = init?.signal as AbortSignal;
        return Promise.resolve(stalledJsonResponse(observed.signal));
      })
      .mockResolvedValueOnce(jsonResponse(state));
    vi.stubGlobal('fetch', fetchMock);
    const { result, unmount } = renderHook(() => useCallSessionState('call-keepalive-body', true));
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(result.current.callStateIssue?.kind).toBe('gateway_down');
    expect(result.current.lastKeepalive).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });

    expect(observed.signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      callSessionId: 'call-keepalive-body',
      touch: true,
    });
    expect(result.current.lastKeepalive).toEqual({
      callSessionId: 'call-keepalive-body',
      sequence: 1,
    });
    expect(result.current.callStateIssue).toBeNull();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps parent cancellation active until the JSON body settles', async () => {
    vi.useFakeTimers();
    const observed: { signal?: AbortSignal; response?: Response } = {};
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      observed.signal = init?.signal as AbortSignal;
      observed.response = stalledJsonResponse(observed.signal);
      return Promise.resolve(observed.response);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result, unmount } = renderHook(() => useCallSessionState('call-body-cancel', false));
    await act(async () => {
      await Promise.resolve();
    });
    expect(observed.response?.json).toHaveBeenCalledOnce();

    unmount();
    await act(async () => {
      await Promise.resolve();
    });

    expect(observed.signal?.aborted).toBe(true);
    expect(result.current.callStateIssue).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains the existing malformed JSON fallback and clears the completed deadline', async () => {
    vi.useFakeTimers();
    const observed: { signal?: AbortSignal } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        observed.signal = init?.signal as AbortSignal;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.reject(new SyntaxError('Invalid JSON')),
        } as Response);
      })
    );
    const { result, unmount } = renderHook(() => useCallSessionState('call-body-malformed', false));
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.mode).toBe('call');
    expect(result.current.authoritativeStatus).toBeNull();
    expect(result.current.callStateIssue).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(observed.signal?.aborted).toBe(false);
    unmount();
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe('useCallSessionState mode contract', () => {
  it('prefers the versioned mode and retains legacy fallback', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ version: 1, mode: 'wing' }))
      .mockResolvedValueOnce(jsonResponse({ listenOnlyModeEnabled: true }));
    vi.stubGlobal('fetch', fetchMock);

    const first = renderHook(() => useCallSessionState('call-1', false));
    await waitFor(() => expect(first.result.current.mode).toBe('wing'));
    first.unmount();

    const second = renderHook(() => useCallSessionState('call-2', false));
    await waitFor(() => expect(second.result.current.mode).toBe('listen_only'));
  });

  it('switches Call, Wing, and Listen-Only atomically with one request', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ version: 1, mode: 'call' }))
      .mockResolvedValueOnce(
        jsonResponse({
          version: 1,
          callSessionId: 'call-1',
          mode: 'listen_only',
          status: 'listening',
          revision: 4,
          updatedAt: '2026-08-09T12:00:00.000Z',
        })
      );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCallSessionState('call-1', false));
    await waitFor(() => expect(result.current.mode).toBe('call'));

    await act(async () => {
      expect(await result.current.setMode('listen_only')).toBe(true);
    });

    expect(result.current.mode).toBe('listen_only');
    expect(result.current.authoritativeStatus).toBe('listening');
    expect(result.current.lastModeTransition).toMatchObject({
      callSessionId: 'call-1',
      mode: 'listen_only',
      revision: 4,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      callSessionId: 'call-1',
      touch: true,
      mode: 'listen_only',
      wingModeEnabled: false,
      listenOnlyModeEnabled: true,
    });
  });

  it('never lets a stale initial response overwrite a newer mode mutation', async () => {
    const initial = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => initial.promise)
      .mockResolvedValueOnce(
        jsonResponse({
          version: 1,
          callSessionId: 'call-race',
          mode: 'wing',
          status: 'listening',
          revision: 2,
          updatedAt: '2026-08-09T12:00:02.000Z',
        })
      );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCallSessionState('call-race', false));

    await act(async () => {
      expect(await result.current.setMode('wing')).toBe(true);
    });
    expect(result.current.mode).toBe('wing');

    initial.resolve(
      jsonResponse({
        version: 1,
        callSessionId: 'call-race',
        mode: 'call',
        status: 'created',
        revision: 0,
        updatedAt: '2026-08-09T12:00:00.000Z',
      })
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.mode).toBe('wing');
    expect(result.current.lastModeTransition?.revision).toBe(2);
  });

  it('aborts an obsolete mode mutation without showing a false call error', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          version: 1,
          callSessionId: 'call-mode-race',
          mode: 'call',
          status: 'listening',
          revision: 1,
          updatedAt: '2026-08-09T12:00:00.000Z',
        })
      )
      .mockImplementationOnce(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError'))
            );
          })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          version: 1,
          callSessionId: 'call-mode-race',
          mode: 'listen_only',
          status: 'listening',
          revision: 2,
          updatedAt: '2026-08-09T12:00:01.000Z',
        })
      );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCallSessionState('call-mode-race', false));
    await waitFor(() => expect(result.current.authoritativeStatus).toBe('listening'));

    let obsoleteResult: boolean | undefined;
    let currentResult: boolean | undefined;
    await act(async () => {
      const obsolete = result.current.setMode('wing').then((value) => {
        obsoleteResult = value;
      });
      const current = result.current.setMode('listen_only').then((value) => {
        currentResult = value;
      });
      await Promise.all([obsolete, current]);
    });

    expect(obsoleteResult).toBe(false);
    expect(currentResult).toBe(true);
    expect(result.current.mode).toBe('listen_only');
    expect(result.current.callStateIssue).toBeNull();
    expect(result.current.callStateError).toBeNull();
  });

  it('keeps the current mode mutation pending after an obsolete mutation aborts', async () => {
    const currentMutation = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          version: 1,
          callSessionId: 'call-mode-pending-race',
          mode: 'call',
          status: 'listening',
          revision: 1,
          updatedAt: '2026-08-09T12:00:00.000Z',
        })
      )
      .mockImplementationOnce(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError'))
            );
          })
      )
      .mockImplementationOnce(() => currentMutation.promise);
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCallSessionState('call-mode-pending-race', false));
    await waitFor(() => expect(result.current.authoritativeStatus).toBe('listening'));

    let obsolete!: Promise<boolean>;
    let current!: Promise<boolean>;
    act(() => {
      obsolete = result.current.setMode('wing');
      current = result.current.setMode('listen_only');
    });
    await act(async () => {
      await expect(obsolete).resolves.toBe(false);
    });

    expect(result.current.modePending).toBe(true);
    expect(result.current.listenOnlyModePending).toBe(true);

    currentMutation.resolve(
      jsonResponse({
        version: 1,
        callSessionId: 'call-mode-pending-race',
        mode: 'listen_only',
        status: 'listening',
        revision: 2,
        updatedAt: '2026-08-09T12:00:01.000Z',
      })
    );
    await act(async () => {
      await expect(current).resolves.toBe(true);
    });
    expect(result.current.modePending).toBe(false);
    expect(result.current.mode).toBe('listen_only');
  });

  it('clears a pending mode mutation when the active call session changes', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          version: 1,
          callSessionId: 'call-old',
          mode: 'wing',
          status: 'listening',
          revision: 1,
          updatedAt: '2026-08-09T12:00:00.000Z',
        })
      )
      .mockImplementationOnce(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError'))
            );
          })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          version: 1,
          callSessionId: 'call-new',
          mode: 'call',
          status: 'listening',
          revision: 1,
          updatedAt: '2026-08-09T12:00:01.000Z',
        })
      );
    vi.stubGlobal('fetch', fetchMock);
    const { result, rerender } = renderHook(
      ({ callSessionId }) => useCallSessionState(callSessionId, false),
      { initialProps: { callSessionId: 'call-old' } }
    );
    await waitFor(() => expect(result.current.mode).toBe('wing'));

    let oldMutation!: Promise<boolean>;
    act(() => {
      oldMutation = result.current.setMode('listen_only');
    });
    expect(result.current.modePending).toBe(true);

    rerender({ callSessionId: 'call-new' });

    await act(async () => {
      await expect(oldMutation).resolves.toBe(false);
    });
    await waitFor(() => expect(result.current.authoritativeStatus).toBe('listening'));
    expect(result.current.mode).toBe('call');
    expect(result.current.modePending).toBe(false);
    expect(result.current.listenOnlyModePending).toBe(false);
  });

  it('carries exact structured failures without guessing from message text', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { code: 'provider_failure', message: 'Configured voice provider is unavailable.' },
          503
        )
      )
      .mockResolvedValueOnce(
        jsonResponse({ message: 'Provider words without a classified code.' }, 400)
      );
    vi.stubGlobal('fetch', fetchMock);

    const first = renderHook(() => useCallSessionState('call-1', false));
    await waitFor(() => expect(first.result.current.callStateIssue?.kind).toBe('provider_failure'));
    first.unmount();

    const second = renderHook(() => useCallSessionState('call-2', false));
    await waitFor(() => expect(second.result.current.callStateIssue?.kind).toBe('unknown'));
  });

  it.each([
    ['failed', 'provider_failure', false],
    ['degraded', 'gateway_down', true],
    ['degraded', 'no_route', false],
  ] as const)(
    'surfaces a successful %s state carrying exact %s provider health',
    async (status, code, retryable) => {
      const fetchMock = vi.fn().mockResolvedValueOnce(
        jsonResponse({
          version: 1,
          callSessionId: `call-${code}`,
          mode: 'call',
          status,
          revision: 3,
          updatedAt: '2026-08-09T12:00:00.000Z',
          error: {
            code,
            message: `Structured ${code} state.`,
            retryable,
          },
        })
      );
      vi.stubGlobal('fetch', fetchMock);

      const { result, unmount } = renderHook(() => useCallSessionState(`call-${code}`, false));

      await waitFor(() => expect(result.current.callStateIssue?.kind).toBe(code));
      expect(result.current.callStateIssue).toEqual({
        kind: code,
        message: `Structured ${code} state.`,
        ...(retryable ? { retryable: true } : {}),
      });
      expect(result.current.callStateRetryable).toBe(retryable);
      unmount();
    }
  );

  it('does not turn an ended state into an error even if stale failure fields are present', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        jsonResponse({
          version: 1,
          callSessionId: 'call-ended',
          mode: 'call',
          status: 'ended',
          revision: 8,
          updatedAt: '2026-08-09T12:00:00.000Z',
          error: {
            code: 'provider_failure',
            message: 'Stale provider state.',
            retryable: true,
          },
        })
      )
    );

    const { result } = renderHook(() => useCallSessionState('call-ended', false));

    await waitFor(() => expect(result.current.mode).toBe('call'));
    expect(result.current.callStateIssue).toBeNull();
    expect(result.current.callStateError).toBeNull();
    expect(result.current.callStateRetryable).toBe(false);
  });

  it('rejects a state response owned by a different call session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        jsonResponse({
          version: 1,
          callSessionId: 'call-other',
          mode: 'wing',
          status: 'listening',
          revision: 4,
          updatedAt: '2026-08-09T12:00:00.000Z',
        })
      )
    );

    const { result } = renderHook(() => useCallSessionState('call-expected', false));

    await waitFor(() => expect(result.current.callStateIssue?.kind).toBe('auth_expired'));
    expect(result.current.mode).toBe('call');
    expect(result.current.authoritativeStatus).toBeNull();
  });

  it('reconciles startup health after one second and stops when provider state settles', async () => {
    vi.useFakeTimers();
    const createdState = {
      version: 1,
      callSessionId: 'call-startup',
      mode: 'call',
      status: 'created',
      revision: 0,
      updatedAt: '2026-08-09T12:00:00.000Z',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(createdState))
      .mockResolvedValueOnce(
        jsonResponse({
          ...createdState,
          status: 'failed',
          revision: 1,
          error: {
            code: 'provider_failure',
            message: 'The configured provider could not start.',
            retryable: true,
          },
        })
      );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCallSessionState('call-startup', true));

    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.callStateIssue).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.callStateIssue).toMatchObject({
      kind: 'provider_failure',
      retryable: true,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('never overlaps startup reconciliation with a pending state request', async () => {
    vi.useFakeTimers();
    const first = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(
        jsonResponse({
          version: 1,
          callSessionId: 'call-pending',
          mode: 'call',
          status: 'listening',
          revision: 1,
          updatedAt: '2026-08-09T12:00:00.000Z',
        })
      );
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useCallSessionState('call-pending', true));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    first.resolve(
      jsonResponse({
        version: 1,
        callSessionId: 'call-pending',
        mode: 'call',
        status: 'created',
        revision: 0,
        updatedAt: '2026-08-09T12:00:00.000Z',
      })
    );
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('retries native fetch TypeErrors but not message-shaped generic errors', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('transport failed'))
      .mockResolvedValueOnce(jsonResponse({ version: 1, mode: 'wing' }));
    vi.stubGlobal('fetch', fetchMock);
    const first = renderHook(() => useCallSessionState('call-1', false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(first.result.current.mode).toBe('wing');
    first.unmount();
    vi.useRealTimers();

    const genericFetchMock = vi.fn().mockRejectedValue(new Error('Failed to fetch'));
    vi.stubGlobal('fetch', genericFetchMock);
    const second = renderHook(() => useCallSessionState('call-2', false));
    await waitFor(() => expect(second.result.current.callStateError).not.toBeNull());
    expect(genericFetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts a hung state request and exposes a retryable degraded issue', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError'))
          );
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCallSessionState('call-1', false));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_001);
    });

    expect(result.current.callStateIssue).toMatchObject({ kind: 'gateway_down' });
    expect(result.current.callStateError).toMatch(/before the voice runtime responded/i);
    expect(result.current.callStateRetryable).toBe(true);
    vi.useRealTimers();
  });

  it('publishes a call-scoped receipt only for successful existing keepalives', async () => {
    vi.useFakeTimers();
    let reads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        reads += 1;
        return Promise.resolve(
          jsonResponse(
            {
              version: 1,
              callSessionId: 'call-pulse',
              mode: 'call',
              status: 'listening',
              revision: 1,
              updatedAt: '2026-08-09T12:00:00.000Z',
            },
            reads === 3 ? 503 : 200
          )
        );
      })
    );
    const { result, unmount } = renderHook(() => useCallSessionState('call-pulse', true));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.lastKeepalive).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25_000);
    });
    expect(result.current.lastKeepalive).toEqual({ callSessionId: 'call-pulse', sequence: 1 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25_000);
    });
    expect(result.current.lastKeepalive?.sequence).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25_000);
    });
    expect(result.current.lastKeepalive?.sequence).toBe(2);
    unmount();
    const stoppedAt = reads;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25_000);
    });
    expect(reads).toBe(stoppedAt);
    vi.useRealTimers();
  });
});
