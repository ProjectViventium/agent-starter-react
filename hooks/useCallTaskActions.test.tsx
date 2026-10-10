import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { proxyCallTaskRequest } from '@/app/api/call-tasks/proxy';
import { useCallTaskActions } from '@/hooks/useCallTaskActions';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.VIVENTIUM_LIBRECHAT_ORIGIN;
  delete process.env.VIVENTIUM_CALL_SESSION_SECRET;
});

describe('useCallTaskActions', () => {
  it('calls the frozen cancel, retry, and input routes', async () => {
    let sequence = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      sequence += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            event: {
              version: 1,
              eventId: `action-${sequence}`,
              sequence,
              emittedAt: '2026-08-10T02:00:00.000Z',
              callSessionId: 'call-1',
              taskId: 'task-1',
              type: 'state',
              state: 'running',
              cancellable: true,
              retryable: false,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCallTaskActions('call-1'));

    await act(async () => {
      expect(await result.current.cancel('task-1')).toBe(true);
      expect(await result.current.retry('task-1')).toBe(true);
      expect(await result.current.submitInput('task-1', '  Use the annual report.  ')).toBe(true);
    });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/api/call-tasks/task-1/cancel',
      '/api/call-tasks/task-1/retry',
      '/api/call-tasks/task-1/input',
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      callSessionId: 'call-1',
      input: 'Use the annual report.',
    });
  });

  it('rejects unsafe IDs and exposes server failures inline', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'Task can no longer be cancelled.' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCallTaskActions('call-1'));

    await act(async () => {
      expect(await result.current.cancel('../unsafe')).toBe(false);
      expect(await result.current.cancel('task-1')).toBe(false);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.actionError).toBe('Task can no longer be cancelled.');
  });

  it('aborts a hung task action and reports that no action was confirmed', async () => {
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
    const { result } = renderHook(() => useCallTaskActions('call-1'));

    let outcome: boolean | undefined;
    await act(async () => {
      const request = result.current.cancel('task-1').then((value) => {
        outcome = value;
      });
      await vi.advanceTimersByTimeAsync(5_001);
      await request;
    });

    expect(outcome).toBe(false);
    expect(result.current.actionError).toMatch(/did not respond/i);
    expect(result.current.actionError).toMatch(/no action was confirmed/i);
    expect(result.current.actionRetryable).toBe(true);
    vi.useRealTimers();
  });

  it('applies a strict authoritative recovering event from a failed cancellation response', async () => {
    const event = {
      version: 1,
      eventId: 'cancel-recovering-1',
      sequence: 4,
      emittedAt: '2026-08-10T02:00:00.000Z',
      callSessionId: 'call-1',
      taskId: 'task-1',
      type: 'error',
      state: 'recovering',
      phase: 'cancel_barrier_recovering',
      label: 'Cancellation needs retry',
      cancellable: true,
      retryable: true,
      error: {
        code: 'cancel_barrier_unavailable',
        message: 'Cancellation could not be made durable.',
        retryable: true,
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 'gateway_down',
            message: 'Cancellation could not be made durable. Please retry.',
            retryable: true,
            event,
          }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );
    const onTaskEvent = vi.fn();
    const { result } = renderHook(() => useCallTaskActions('call-1', onTaskEvent));

    await act(async () => {
      expect(await result.current.cancel('task-1')).toBe(false);
    });

    expect(onTaskEvent).toHaveBeenCalledWith(event);
    expect(result.current.actionError).toMatch(/made durable/i);
    expect(result.current.actionRetryable).toBe(true);
  });

  it('rejects a malformed action event instead of guessing state from error copy', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ event: { state: 'recovering' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    const onTaskEvent = vi.fn();
    const { result } = renderHook(() => useCallTaskActions('call-1', onTaskEvent));

    await act(async () => {
      expect(await result.current.cancel('task-1')).toBe(false);
    });

    expect(onTaskEvent).not.toHaveBeenCalled();
    expect(result.current.actionError).toMatch(/invalid task state/i);
    expect(result.current.actionRetryable).toBe(true);
  });

  it('treats a truncated successful action without an event as visible recovery', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ version: 1, outcome: 'cancelling' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    const { result } = renderHook(() => useCallTaskActions('call-1'));

    await act(async () => {
      expect(await result.current.cancel('task-1')).toBe(false);
    });

    expect(result.current.actionError).toMatch(/invalid task state/i);
    expect(result.current.actionRetryable).toBe(true);
  });

  it('applies retry parent and child events in authoritative response order without room data', async () => {
    const base = {
      version: 1 as const,
      emittedAt: '2026-08-10T02:00:00.000Z',
      callSessionId: 'call-1',
      cancellable: false,
      retryable: false,
    };
    const previousEvent = {
      ...base,
      eventId: 'parent-retried',
      sequence: 5,
      taskId: 'task-1',
      type: 'state',
      state: 'failed',
      phase: 'retried',
      label: 'Retry started',
    };
    const queued = {
      ...base,
      eventId: 'child-queued',
      sequence: 1,
      taskId: 'task-child',
      parentTaskId: 'task-1',
      type: 'state',
      state: 'queued',
    };
    const running = {
      ...base,
      eventId: 'child-running',
      sequence: 2,
      taskId: 'task-child',
      parentTaskId: 'task-1',
      type: 'state',
      state: 'running',
    };
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ previousEvent, events: [queued, running], event: running }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )
    );
    const received: unknown[] = [];
    const { result } = renderHook(() =>
      useCallTaskActions('call-1', (event) => received.push(event))
    );

    await act(async () => {
      expect(await result.current.retry('task-1')).toBe(true);
    });

    expect(received).toEqual([previousEvent, queued, running]);
  });
  it.each([
    ['already_completed', 'completed'],
    ['not_active', 'failed'],
  ])(
    'applies a BFF-bound %s event without confirming cancellation or leaving a call alarm',
    async (outcome, state) => {
      process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
      process.env.VIVENTIUM_CALL_SESSION_SECRET = 'server-secret';
      const event = {
        version: 1,
        eventId: 'terminal-1',
        sequence: 7,
        emittedAt: '2026-10-05T12:00:00.000Z',
        callSessionId: 'call-1',
        taskId: 'task-1',
        type: 'state',
        state,
        cancellable: false,
        retryable: false,
      };
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: RequestInfo | URL) => {
          if (url instanceof URL)
            return new Response(JSON.stringify({ version: 1, outcome, event }), { status: 409 });
          return proxyCallTaskRequest(
            '/api/viventium/voice/tasks/task-1/cancel',
            'POST',
            'call-1',
            'A'.repeat(43),
            { callSessionId: 'call-1' }
          );
        })
      );
      const onTaskEvent = vi.fn();
      const { result } = renderHook(() => useCallTaskActions('call-1', onTaskEvent));
      await act(async () => {
        expect(await result.current.cancel('../unsafe')).toBe(false);
      });
      expect(result.current.actionError).not.toBeNull();
      await act(async () => {
        expect(await result.current.cancel('task-1')).toBe(false);
      });
      expect(onTaskEvent).toHaveBeenCalledExactlyOnceWith(event);
      expect(result.current.actionError).toBeNull();
      expect(result.current.actionRetryable).toBe(false);
      expect(result.current.pendingTaskIds.size).toBe(0);
    }
  );
  it.each([
    { callSessionId: 'foreign-call' },
    { taskId: 'foreign-task' },
    { taskId: 'child-task', parentTaskId: 'task-1' },
    { state: 'running' },
    { cancellable: true },
  ])('does not silently resolve an invalid terminal cancellation event %p', async (patch) => {
    const event = {
      version: 1,
      eventId: 'invalid-1',
      sequence: 1,
      emittedAt: '2026-10-05T12:00:00.000Z',
      callSessionId: 'call-1',
      taskId: 'task-1',
      type: 'state',
      state: 'completed',
      cancellable: false,
      retryable: false,
      ...patch,
    };
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ outcome: 'already_completed', event }), { status: 409 })
        )
    );
    const onTaskEvent = vi.fn();
    const { result } = renderHook(() => useCallTaskActions('call-1', onTaskEvent));
    await act(async () => {
      expect(await result.current.cancel('task-1')).toBe(false);
    });
    expect(result.current.actionError).not.toBeNull();
  });

  it('logs only structured action stages and excludes identity, credentials and task input', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            event: {
              version: 1,
              eventId: 'event-1',
              sequence: 1,
              emittedAt: '2026-10-05T12:00:00.000Z',
              callSessionId: 'call-1',
              taskId: 'task-1',
              type: 'state',
              state: 'running',
              cancellable: true,
              retryable: false,
            },
          }),
          { status: 200 }
        )
      )
    );
    const { result } = renderHook(() => useCallTaskActions('call-1'));
    await act(async () => {
      expect(await result.current.submitInput('task-1', 'private-user-input')).toBe(true);
    });
    const records = debug.mock.calls.filter((args) => args[0] === '[ViventiumCallTaskAction]');
    expect(records).toHaveLength(3);
    expect(records.every((args) => typeof args[1] === 'string')).toBe(true);
    const traces = records.map((args) => JSON.parse(String(args[1])));
    expect(traces[0]).toEqual({ stage: 'request', action: 'input' });
    expect(traces[1]).toEqual({
      stage: 'response',
      action: 'input',
      status: 200,
      elapsedMs: expect.any(Number),
    });
    expect(traces[1].elapsedMs).toBeGreaterThanOrEqual(0);
    expect(traces[2]).toEqual({
      stage: 'validation',
      action: 'input',
      outcome: null,
      boundEventCount: 1,
      malformedEvent: false,
    });
    const serialized = JSON.stringify(records);
    for (const privateValue of [
      'call-1',
      'task-1',
      'private-user-input',
      'server-secret',
      'http',
      'capability',
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });
  it('logs a classified fetch failure without exposing the raw error message', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('private-error-and-credential'))
    );
    const { result } = renderHook(() => useCallTaskActions('call-1'));
    await act(async () => {
      expect(await result.current.cancel('task-1')).toBe(false);
    });
    const records = debug.mock.calls.filter((args) => args[0] === '[ViventiumCallTaskAction]');
    expect(JSON.parse(String(records.at(-1)?.[1]))).toEqual({
      stage: 'failure',
      action: 'cancel',
      failureClass: 'fetch',
    });
    expect(JSON.stringify(records)).not.toContain('private-error-and-credential');
  });
});

describe('completed native speech Stop action', () => {
  it('forwards exact ref and accepts completed-control event without fabricating cancellation', async () => {
    const event = {
      version: 1,
      eventId: 'playout-stop',
      sequence: 2,
      emittedAt: '2026-08-10T02:00:00.000Z',
      callSessionId: 'call-1',
      taskId: 'task-1',
      type: 'state',
      state: 'completed',
      cancellable: false,
      retryable: false,
      presentation: { ref: 'speech-1', state: 'stop_requested', startedAtMs: 1000 },
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ version: 1, outcome: 'playout_stop_requested', event }), {
        status: 200,
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const onEvent = vi.fn();
    const { result } = renderHook(() => useCallTaskActions('call-1', onEvent));
    await act(async () => {
      expect(await result.current.cancel('task-1', 'speech-1')).toBe(true);
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      callSessionId: 'call-1',
      presentationRef: 'speech-1',
    });
    expect(onEvent).toHaveBeenCalledWith(event);
    expect(result.current.actionError).toBeNull();
  });
});
