export const CALL_RESULT_BRIDGE_TYPE = 'viventium.call.event.v1' as const;

export type CallResultBridgePayload = {
  version: 1;
  type: typeof CALL_RESULT_BRIDGE_TYPE;
  event: 'result' | 'ended';
  callSessionId: string;
  conversationId?: string;
  resultMessageId?: string;
};

type MessageTarget = {
  postMessage: (message: unknown, targetOrigin: string) => void;
};

function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
  } catch {
    return false;
  }
}

/** Referrer is supplied by the browser for the exact page which opened the call. */
export function resolveLinkedChatOrigin(referrer: string): string | null {
  if (!referrer) {
    return null;
  }
  try {
    const url = new URL(referrer);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function createCallResultBridge({
  opener,
  targetOrigin,
}: {
  opener: MessageTarget | null;
  targetOrigin: string | null;
}) {
  const sent = new Set<string>();
  return {
    send(payload: CallResultBridgePayload): boolean {
      if (!opener || !targetOrigin || !isHttpOrigin(targetOrigin)) {
        return false;
      }
      if (payload.event === 'result' && !payload.conversationId) {
        return false;
      }
      const key = `${payload.event}\0${payload.callSessionId}\0${payload.conversationId ?? ''}\0${payload.resultMessageId ?? ''}`;
      if (sent.has(key)) {
        return false;
      }
      sent.add(key);
      opener.postMessage(payload, targetOrigin);
      return true;
    },
  };
}
