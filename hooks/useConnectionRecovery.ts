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
// VIVENTIUM END

import { useCallback, useEffect, useRef } from 'react';
import { ConnectionState } from 'livekit-client';

/** How long to wait (ms) after page becomes visible before checking connection state.
 * This gives LiveKit's built-in reconnection a chance to recover first. */
const RECOVERY_DELAY_MS = 2000;

/** Maximum time (ms) to wait for built-in reconnection before attempting fresh start. */
const RECONNECT_GRACE_MS = 5000;

interface UseConnectionRecoveryOptions {
  /** Current LiveKit connection state */
  connectionState: ConnectionState;
  /** Whether the session is connected */
  isConnected: boolean;
  /** Function to start a new session */
  start: () => Promise<void>;
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
  const recoveryAttemptedRef = useRef(false);
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep track of connected state continuously
  useEffect(() => {
    if (isConnected) {
      wasConnectedRef.current = true;
      recoveryAttemptedRef.current = false;
    } else if (connectionState === ConnectionState.Disconnected) {
      // Don't reset wasConnected here - we need to know it was connected before
    }
  }, [isConnected, connectionState]);

  const attemptRecovery = useCallback(async () => {
    // Only attempt if we were previously connected, are now disconnected,
    // and haven't already tried recovery for this visibility cycle.
    if (!wasConnectedRef.current || recoveryAttemptedRef.current) {
      return;
    }

    recoveryAttemptedRef.current = true;

    try {
      await start();
    } catch (error) {
      console.warn('[Viventium] Connection recovery failed:', error);
      // Reset so we can try again on next visibility change
      recoveryAttemptedRef.current = false;
    }
  }, [start]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        // Page going to background - clear any pending recovery
        if (recoveryTimerRef.current) {
          clearTimeout(recoveryTimerRef.current);
          recoveryTimerRef.current = null;
        }
        return;
      }

      // Page became visible again
      if (!wasConnectedRef.current) {
        return;
      }

      // Wait a moment to let LiveKit's built-in reconnection try first
      recoveryTimerRef.current = setTimeout(() => {
        recoveryTimerRef.current = null;

        // Check if still disconnected after grace period.
        // We use the refs because the closure captures the values at setup time.
        // The connectionState might have changed during the grace period.
        // We'll rely on the effect dependency to handle state changes.
      }, RECOVERY_DELAY_MS);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (recoveryTimerRef.current) {
        clearTimeout(recoveryTimerRef.current);
        recoveryTimerRef.current = null;
      }
    };
  }, []);

  // When we detect the connection is disconnected AND we were previously connected,
  // AND the page is visible (back from sleep), attempt recovery.
  useEffect(() => {
    if (
      connectionState === ConnectionState.Disconnected &&
      wasConnectedRef.current &&
      !recoveryAttemptedRef.current &&
      document.visibilityState === 'visible'
    ) {
      // Give LiveKit's built-in reconnection a grace period
      const timer = setTimeout(() => {
        attemptRecovery();
      }, RECONNECT_GRACE_MS);

      return () => clearTimeout(timer);
    }
  }, [connectionState, attemptRecovery]);
}
