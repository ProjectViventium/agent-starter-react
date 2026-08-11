import { describe, expect, it, vi } from 'vitest';
import { CallRequestError } from '@/lib/call-start';
import { enableCallMicrophone, queryMicrophonePermissionState } from '@/lib/microphone-start';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe('one-click microphone startup policy', () => {
  it('awaits a slow browser prompt without applying the app startup timeout', async () => {
    vi.useFakeTimers();
    const pendingEnable = deferred();
    const disable = vi.fn().mockResolvedValue(undefined);
    const startup = enableCallMicrophone({
      permissionState: 'prompt',
      enable: () => pendingEnable.promise,
      disable,
      grantedTimeoutMs: 25,
    });

    await vi.advanceTimersByTimeAsync(250);
    expect(disable).not.toHaveBeenCalled();
    pendingEnable.resolve();

    await expect(startup).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it('maps a slow browser-prompt denial to the structured microphone error', async () => {
    vi.useFakeTimers();
    const pendingEnable = deferred();
    const startup = enableCallMicrophone({
      permissionState: 'prompt',
      enable: () => pendingEnable.promise,
      disable: vi.fn().mockResolvedValue(undefined),
      grantedTimeoutMs: 25,
    });

    await vi.advanceTimersByTimeAsync(250);
    pendingEnable.reject(new DOMException('Permission denied', 'NotAllowedError'));

    await expect(startup).rejects.toMatchObject({
      code: 'mic_denied',
      retryable: false,
    } satisfies Partial<CallRequestError>);
    vi.useRealTimers();
  });

  it('treats a missing Permissions API as unsupported and still awaits the browser decision', async () => {
    vi.useFakeTimers();
    await expect(queryMicrophonePermissionState(undefined)).resolves.toBe('unsupported');
    const pendingEnable = deferred();
    const startup = enableCallMicrophone({
      permissionState: 'unsupported',
      enable: () => pendingEnable.promise,
      disable: vi.fn().mockResolvedValue(undefined),
      grantedTimeoutMs: 25,
    });

    await vi.advanceTimersByTimeAsync(250);
    pendingEnable.resolve();

    await expect(startup).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it('maps a missing microphone to its distinct structured error', async () => {
    await expect(
      enableCallMicrophone({
        permissionState: 'prompt',
        enable: () => Promise.reject(new DOMException('No device', 'NotFoundError')),
        disable: vi.fn().mockResolvedValue(undefined),
        grantedTimeoutMs: 25,
      })
    ).rejects.toMatchObject({ code: 'microphone_missing', retryable: false });
  });

  it('bounds an already-granted startup and disables both immediately and after late success', async () => {
    vi.useFakeTimers();
    const pendingEnable = deferred();
    const disable = vi.fn().mockResolvedValue(undefined);
    const startup = enableCallMicrophone({
      permissionState: 'granted',
      enable: () => pendingEnable.promise,
      disable,
      grantedTimeoutMs: 25,
    });

    const rejection = expect(startup).rejects.toMatchObject({
      code: 'gateway_down',
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(26);
    await rejection;
    expect(disable).toHaveBeenCalledTimes(1);

    pendingEnable.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(disable).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
