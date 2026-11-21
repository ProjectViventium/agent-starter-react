'use client';

import { createContext, useContext } from 'react';
import type { CallKeepaliveReceipt, VoiceCallMode } from '@/hooks/useCallSessionState';
import type { VoiceCallStatus } from '@/lib/call-state';

/**
 * What every part of the call screen needs to know about this call (CP-CMP-012): which call it
 * is, its mode, and what the server last said about it. Provided once by `App`.
 */
export type CallContextValue = {
  callSessionId: string | null;
  conversationId: string | null;
  mode: VoiceCallMode;
  /** A mode change is waiting for the server's confirmation. */
  modePending: boolean;
  setMode: (mode: VoiceCallMode) => void;
  /** The server's own status for the call; `null` until it is known. */
  authoritativeStatus: VoiceCallStatus | null;
  /** Set when the server's call record could not be read or changed. */
  callStateError: string | null;
  lastKeepalive: CallKeepaliveReceipt | null;
};

const DEFAULT_CALL_CONTEXT: CallContextValue = {
  callSessionId: null,
  conversationId: null,
  mode: 'call',
  modePending: false,
  setMode: () => undefined,
  authoritativeStatus: null,
  callStateError: null,
  lastKeepalive: null,
};

const CallContext = createContext<CallContextValue>(DEFAULT_CALL_CONTEXT);

export const CallProvider = CallContext.Provider;

export function useCall(): CallContextValue {
  return useContext(CallContext);
}
