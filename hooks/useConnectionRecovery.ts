// VIVENTIUM START
// Feature: Connection recovery after mobile screen sleep
// Purpose: When the phone screen sleeps and the LiveKit WebRTC connection drops,
// this hook detects the page becoming visible again and attempts to reconnect.
//
// Behavior:
// - Monitors page visibility via visibilitychange event
// - When the page becomes visible and the connection was previously active but is
//   now disconnected, it attempts to restart the session.
// - Uses a short delay to allow LiveKit's built-in reconnection to attempt first.
// - Only attempts recovery once per visibility change cycle to prevent loops.
// - Does not recover after an intentional visible-page disconnect, such as End Call.
// VIVENTIUM END
import { useCallback, useEffect, useRef } from 'react';
import { ConnectionState } from 'livekit-client';

/** How long (ms) to let LiveKit's built-in reconnection recover after a hidden page returns. */
const RECONNECT_GRACE_MS = 5000;

interface UseConnectionRecoveryOptions {
  /** Current LiveKit connection state */
  connectionState: ConnectionState;
  /** Whether the session is connected */
  isConnected: boolean;
  /** Function to start a new session */
  start: () => Promise<void>;
}

function isRecoverableActiveState(connectionState: ConnectionState): boolean {
  return (
    connectionState === ConnectionState.Connecting ||
    connectionState === ConnectionState.Reconnecting ||
    connectionState === ConnectionState.SignalReconnecting
  );
}

/**
 * Attempts to recover a LiveKit voice call connection after the page returns
 * from a background/sleep state.
 */
export function useConnectionRecovery({
  connectionState,
  isConnected,
  start,
}: UseConnectionRecoveryOptions): void {
  // Track whether the session was active before the page went to background.
  const wasConnectedRef = useRef(false);
  const shouldRecoverOnVisibleRef = useRef(false);
  const recoveryAttemptedRef = useRef(false);
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isConnectedRef = useRef(isConnected);
  const connectionStateRef = useRef(connectionState);

  // Keep track of connected state continuously.
  useEffect(() => {
    isConnectedRef.current = isConnected;
    connectionStateRef.current = connectionState;
    if (isConnected) {
      wasConnectedRef.current = true;
      recoveryAttemptedRef.current = false;
      return;
    }

    if (
      connectionState === ConnectionState.Disconnected &&
      typeof document !== 'undefined' &&
      document.visibilityState === 'visible'
    ) {
      if (wasConnectedRef.current && shouldRecoverOnVisibleRef.current) {
        return;
      }
      // A visible-page disconnect is intentional user action in this UI, such as End Call.
      wasConnectedRef.current = false;
      shouldRecoverOnVisibleRef.current = false;
      recoveryAttemptedRef.current = false;
    }
  }, [isConnected, connectionState]);

  const attemptRecovery = useCallback(async () => {
    // Only attempt if we were previously connected, are now disconnected,
    // and haven't already tried recovery for this visibility cycle.
    if (
      !wasConnectedRef.current ||
      !shouldRecoverOnVisibleRef.current ||
      recoveryAttemptedRef.current ||
      connectionStateRef.current !== ConnectionState.Disconnected ||
      isConnectedRef.current
    ) {
      return;
    }

    recoveryAttemptedRef.current = true;
    shouldRecoverOnVisibleRef.current = false;

    try {
      await start();
    } catch (error) {
      console.warn('[Viventium] Connection recovery failed:', error);
      // Leave the call stopped after a failed recovery; the user can start again manually.
      wasConnectedRef.current = false;
      recoveryAttemptedRef.current = false;
      shouldRecoverOnVisibleRef.current = false;
    }
  }, [start]);

  const scheduleRecoveryCheck = useCallback(() => {
    if (recoveryTimerRef.current) {
      return;
    }
    recoveryTimerRef.current = setTimeout(() => {
      recoveryTimerRef.current = null;
      void attemptRecovery();
    }, RECONNECT_GRACE_MS);
  }, [attemptRecovery]);

  useEffect(() => {
    if (
      connectionState !== ConnectionState.Disconnected ||
      typeof document === 'undefined' ||
      document.visibilityState !== 'visible' ||
      !wasConnectedRef.current ||
      !shouldRecoverOnVisibleRef.current ||
      isConnectedRef.current
    ) {
      return;
    }

    scheduleRecoveryCheck();
  }, [connectionState, scheduleRecoveryCheck]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        if (isConnectedRef.current || isRecoverableActiveState(connectionStateRef.current)) {
          wasConnectedRef.current = true;
          shouldRecoverOnVisibleRef.current = true;
          recoveryAttemptedRef.current = false;
        } else {
          wasConnectedRef.current = false;
          shouldRecoverOnVisibleRef.current = false;
        }
        // Page going to background - clear any pending recovery
        if (recoveryTimerRef.current) {
          clearTimeout(recoveryTimerRef.current);
          recoveryTimerRef.current = null;
        }
        return;
      }

      // Page became visible again
      if (!wasConnectedRef.current || !shouldRecoverOnVisibleRef.current) {
        return;
      }

      if (isConnectedRef.current) {
        shouldRecoverOnVisibleRef.current = false;
        recoveryAttemptedRef.current = false;
        return;
      }

      // Wait a moment to let LiveKit's built-in reconnection try first.
      scheduleRecoveryCheck();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (recoveryTimerRef.current) {
        clearTimeout(recoveryTimerRef.current);
        recoveryTimerRef.current = null;
      }
    };
  }, [scheduleRecoveryCheck]);
}
