'use client';

import * as React from 'react';
import { callCapabilityStorageKey, readCallOpenerOrigin } from '@/lib/call-browser-capability';
import {
  CALL_RESULT_BRIDGE_TYPE,
  createCallResultBridge,
  resolveLinkedChatHref,
  resolveLinkedChatOrigin,
} from '@/lib/call-handoff';
import type { VoiceTaskView } from '@/lib/voice-events';

const TERMINAL_STATES = new Set([
  'completed',
  'failed',
  'cancelled_confirmed',
  'cancelled_unenforceable',
]);

export function useCallResultBridge({
  callSessionId,
  conversationId,
  tasks,
  onLinkedChatHrefChange,
}: {
  callSessionId: string | null;
  conversationId: string | null;
  tasks: VoiceTaskView[];
  onLinkedChatHrefChange?: (href: string | null) => void;
}) {
  const targetOrigin =
    typeof document === 'undefined'
      ? null
      : ((callSessionId ? readCallOpenerOrigin(callSessionId) : null) ??
        resolveLinkedChatOrigin(document.referrer));
  const bridgeRef = React.useRef<ReturnType<typeof createCallResultBridge> | null>(null);
  const lastConversationIdRef = React.useRef(conversationId);

  React.useEffect(() => {
    lastConversationIdRef.current = conversationId;
    bridgeRef.current = createCallResultBridge({
      opener: typeof window === 'undefined' ? null : window.opener,
      targetOrigin,
    });
  }, [targetOrigin, callSessionId]);

  React.useEffect(() => {
    if (!callSessionId || !callCapabilityStorageKey(callSessionId)) {
      onLinkedChatHrefChange?.(null);
      return;
    }
    for (const task of tasks) {
      if (task.callSessionId !== callSessionId) continue;
      const taskConversationId = task.conversationId ?? conversationId;
      if (resolveLinkedChatHref(targetOrigin, taskConversationId)) {
        lastConversationIdRef.current = taskConversationId;
      }
      if (taskConversationId && (task.type === 'result' || TERMINAL_STATES.has(task.state))) {
        bridgeRef.current?.send({
          version: 1,
          type: CALL_RESULT_BRIDGE_TYPE,
          event: 'result',
          callSessionId,
          conversationId: taskConversationId,
          ...(task.resultMessageId ? { resultMessageId: task.resultMessageId } : {}),
        });
      }
    }
    onLinkedChatHrefChange?.(resolveLinkedChatHref(targetOrigin, lastConversationIdRef.current));
  }, [callSessionId, conversationId, tasks, targetOrigin, onLinkedChatHrefChange]);

  return React.useCallback(() => {
    const linkedConversationId = lastConversationIdRef.current ?? conversationId;
    if (!callSessionId) {
      return false;
    }
    return Boolean(
      bridgeRef.current?.send({
        version: 1,
        type: CALL_RESULT_BRIDGE_TYPE,
        event: 'ended',
        callSessionId,
        ...(linkedConversationId ? { conversationId: linkedConversationId } : {}),
      })
    );
  }, [callSessionId, conversationId]);
}
