import { describe, expect, it, vi } from 'vitest';
import { endCallSessionWithRetry } from '@/hooks/useCallEndLifecycle';

describe('endCallSessionWithRetry', () => {
  it('keeps capability authority through transient failure and confirmed end for refresh truth', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const clearCapability = vi.fn();

    await expect(
      endCallSessionWithRetry('call-1', {
        fetchImpl: fetchImpl as typeof fetch,
        wait: async () => undefined,
        clearCapability,
      })
    ).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(clearCapability).not.toHaveBeenCalled();
  });

  it('treats terminal 410 as ended and does not retry', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 410 }));
    const clearCapability = vi.fn();
    await expect(
      endCallSessionWithRetry('call-1', {
        fetchImpl: fetchImpl as typeof fetch,
        wait: async () => undefined,
        clearCapability,
      })
    ).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(clearCapability).toHaveBeenCalledTimes(1);
  });
});
