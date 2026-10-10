import { callCapabilityStorageKey } from '@/lib/call-browser-capability';
import { CallRequestError, classifyCallIssue } from '@/lib/call-start';

const CALL_MICROPHONE_STORAGE_PREFIX = 'viventium.call.microphone-enabled.v1:';

function microphoneSessionStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readCallMicrophoneEnabled(
  callSessionId: string | null | undefined,
  storage: Pick<Storage, 'getItem'> | null = microphoneSessionStorage()
): boolean | null {
  if (!callSessionId || !callCapabilityStorageKey(callSessionId) || !storage) return null;
  try {
    const value = storage.getItem(`${CALL_MICROPHONE_STORAGE_PREFIX}${callSessionId}`);
    return value === 'true' ? true : value === 'false' ? false : null;
  } catch {
    return null;
  }
}

export function saveCallMicrophoneEnabled(
  callSessionId: string | null | undefined,
  enabled: boolean,
  storage: Pick<Storage, 'setItem'> | null = microphoneSessionStorage()
): void {
  if (!callSessionId || !callCapabilityStorageKey(callSessionId) || !storage) return;
  try {
    storage.setItem(`${CALL_MICROPHONE_STORAGE_PREFIX}${callSessionId}`, String(enabled));
  } catch {
    // A browser storage failure must not block the user's microphone control.
  }
}

export type MicrophonePermissionState = PermissionState | 'unsupported';

type PermissionsBoundary = {
  query: (descriptor: PermissionDescriptor) => Promise<{ state: PermissionState }>;
};

class MicrophoneStartupTimeoutError extends Error {
  constructor() {
    super('The already-authorized microphone did not start before the voice runtime timed out.');
    this.name = 'MicrophoneStartupTimeoutError';
  }
}

export async function queryMicrophonePermissionState(
  permissions: PermissionsBoundary | undefined = typeof navigator !== 'undefined'
    ? (navigator.permissions as PermissionsBoundary | undefined)
    : undefined
): Promise<MicrophonePermissionState> {
  if (!permissions?.query) {
    return 'unsupported';
  }
  try {
    const result = await permissions.query({ name: 'microphone' as PermissionName });
    return result.state === 'granted' || result.state === 'denied' || result.state === 'prompt'
      ? result.state
      : 'unsupported';
  } catch {
    // Safari and older browsers may expose Permissions.query but reject the microphone name.
    return 'unsupported';
  }
}

function structuredMicrophoneError(error: unknown): CallRequestError {
  if (error instanceof CallRequestError) {
    return error;
  }
  const issue = classifyCallIssue(error);
  if (issue.kind === 'mic_denied') {
    return new CallRequestError(
      {
        kind: 'mic_denied',
        message: issue.message || 'Microphone access is blocked for this site.',
      },
      false
    );
  }
  if (issue.kind === 'microphone_missing') {
    return new CallRequestError(
      {
        kind: 'microphone_missing',
        message: issue.message || 'No microphone is available for this call.',
      },
      false
    );
  }
  return new CallRequestError(
    {
      kind: issue.kind,
      message: issue.message || 'Viventium could not start the microphone.',
    },
    false
  );
}

export async function enableCallMicrophone({
  permissionState,
  enable,
  disable,
  grantedTimeoutMs,
  signal,
}: {
  permissionState: MicrophonePermissionState;
  enable: () => Promise<unknown>;
  disable: () => Promise<unknown>;
  grantedTimeoutMs: number;
  signal?: AbortSignal;
}): Promise<void> {
  const terminalError = () =>
    signal?.reason ??
    new CallRequestError(
      {
        kind: 'gateway_down',
        message: 'The call disconnected before the microphone was ready. Please try again.',
      },
      true
    );
  if (signal?.aborted) throw structuredMicrophoneError(terminalError());
  if (permissionState === 'denied') {
    throw new CallRequestError(
      {
        kind: 'mic_denied',
        message: 'Microphone access is blocked for this site.',
      },
      false
    );
  }

  const enablePromise = enable();
  const timeoutMs = Math.max(1, Math.min(Math.floor(grantedTimeoutMs), 60_000));
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | undefined;
  try {
    const pending: Promise<unknown>[] = [enablePromise];
    if (signal) {
      pending.push(
        new Promise<never>((_, reject) => {
          onAbort = () => reject(terminalError());
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        })
      );
    }
    // The browser owns how long its permission prompt stays open. Only terminal call loss
    // cancels that wait; the existing timeout applies solely to already-granted capture.
    if (permissionState === 'granted') {
      pending.push(
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new MicrophoneStartupTimeoutError()), timeoutMs);
        })
      );
    }
    await Promise.race(pending);
    if (signal?.aborted) throw terminalError();
  } catch (error) {
    if (error instanceof MicrophoneStartupTimeoutError || signal?.aborted) {
      // Fail promptly, end the room in the caller, and neutralize both an in-flight enable and a
      // late success. The second disable is required because getUserMedia cannot be aborted.
      void disable().catch(() => undefined);
      void enablePromise.then(
        () => disable().catch(() => undefined),
        () => undefined
      );
      if (signal?.aborted) throw structuredMicrophoneError(terminalError());
    }
    if (error instanceof MicrophoneStartupTimeoutError) {
      throw new CallRequestError(
        {
          kind: 'gateway_down',
          message: error.message,
        },
        true
      );
    }
    throw structuredMicrophoneError(error);
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}
