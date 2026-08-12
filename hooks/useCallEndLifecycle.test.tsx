import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { endCallSessionWithRetry, useCallEndLifecycle } from '@/hooks/useCallEndLifecycle';

afterEach(() => vi.unstubAllGlobals());

describe('useCallEndLifecycle', () => {
  it('ends audio first, sends one nonblocking ended transition, and preserves refresh recovery', () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetchMock);
    const onEnded = vi.fn();
    const endAudio = vi.fn().mockResolvedValue(undefined);
    const { result, unmount } = renderHook(() =>
      useCallEndLifecycle({ callSessionId: 'call-1', onEnded })
    );

    act(() => result.current(endAudio));
    expect(endAudio).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(endAudio.mock.invocationCallOrder[0]).toBeLessThan(
      fetchMock.mock.invocationCallOrder[0]
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/call-session-state',
      expect.objectContaining({
        keepalive: true,
        body: JSON.stringify({ callSessionId: 'call-1', status: 'ended', touch: false }),
      })
    );

    act(() => window.dispatchEvent(new Event('pagehide')));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onEnded).toHaveBeenCalledTimes(1);
    unmount();
    window.dispatchEvent(new Event('beforeunload'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([200, 410])(
    'retries a locally timed-out end request and clears only after authoritative %s',
    async (terminalStatus) => {
      const clearCapability = vi.fn();
      const fetchImpl = vi
        .fn()
        .mockImplementationOnce(
          (_url, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                'abort',
                () => reject(new DOMException('Timed out', 'AbortError')),
                { once: true }
              );
            })
        )
        .mockResolvedValueOnce({ ok: terminalStatus === 200, status: terminalStatus });

      await expect(
        endCallSessionWithRetry('call-timeout', {
          fetchImpl,
          wait: vi.fn().mockResolvedValue(undefined),
          clearCapability,
          attemptTimeoutMs: 1,
        })
      ).resolves.toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(clearCapability).toHaveBeenCalledTimes(1);
    }
  );
});
