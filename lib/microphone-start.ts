import { CallRequestError, classifyCallIssue } from '@/lib/call-start';

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
}: {
  permissionState: MicrophonePermissionState;
  enable: () => Promise<unknown>;
  disable: () => Promise<unknown>;
  grantedTimeoutMs: number;
}): Promise<void> {
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
  if (permissionState !== 'granted') {
    try {
      await enablePromise;
      return;
    } catch (error) {
      throw structuredMicrophoneError(error);
    }
  }

  const timeoutMs = Math.max(1, Math.min(Math.floor(grantedTimeoutMs), 60_000));
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      enablePromise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new MicrophoneStartupTimeoutError()), timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof MicrophoneStartupTimeoutError) {
      // Fail promptly, end the room in the caller, and neutralize both an in-flight enable and a
      // late success. The second disable is required because getUserMedia cannot be aborted.
      void disable().catch(() => undefined);
      void enablePromise.then(
        () => disable().catch(() => undefined),
        () => undefined
      );
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
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}
