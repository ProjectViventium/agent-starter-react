import { callCapabilityStorageKey } from '@/lib/call-browser-capability';

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

/** Navigate to the normal authenticated chat; never rewrite an authored artifact target. */
export function resolveLinkedChatHref(
  origin: string | null,
  conversationId: string | null
): string | null {
  if (
    !origin ||
    !isHttpOrigin(origin) ||
    !conversationId ||
    conversationId === 'new' ||
    conversationId.length > 160 ||
    !/^[A-Za-z0-9_-]+$/.test(conversationId)
  ) {
    return null;
  }
  return `${origin}/c/${encodeURIComponent(conversationId)}`;
}

/** Retain only normal chat navigation in this tab after the call capability is cleared. */
export function retainedLinkedChatHref(
  callSessionId: string,
  href?: string | null,
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
): string | null {
  if (!callCapabilityStorageKey(callSessionId)) return null;
  const key = `viventium.call.linked-chat.v1:${callSessionId}`;
  try {
    const tabStorage =
      storage === undefined
        ? typeof window === 'undefined'
          ? null
          : window.sessionStorage
        : storage;
    if (!tabStorage) return null;
    const value = href ?? tabStorage.getItem(key);
    if (!value) return null;
    const url = new URL(value);
    const id = url.pathname.startsWith('/c/') ? url.pathname.slice(3) : null;
    if (resolveLinkedChatHref(url.origin, id) !== value) return null;
    if (href) tabStorage.setItem(key, value);
    return value;
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
