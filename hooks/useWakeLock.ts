// VIVENTIUM START
// Feature: Screen Wake Lock for voice calls
// Purpose: Prevent the phone screen from sleeping during active voice calls,
// which would cause the WebRTC/LiveKit connection to disconnect.
// Uses the Screen Wake Lock API (W3C standard, supported by all modern browsers).
//
// Behavior:
// - Acquires wake lock when isActive=true (call connected)
// - Releases wake lock when isActive=false (call ended)
// - Re-acquires wake lock on visibilitychange (lock is auto-released when page goes to background)
// - Handles browser support gracefully (no-op on unsupported browsers)
// VIVENTIUM END
import { useCallback, useEffect, useRef } from 'react';

/**
 * Custom hook that uses the Screen Wake Lock API to prevent the device screen
 * from sleeping while a voice call is active.
 *
 * @param isActive - Whether the wake lock should be held (true when call is connected)
 */
export function useWakeLock(isActive: boolean): void {
  const sentinelRef = useRef<WakeLockSentinel | null>(null);
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  const requestWakeLock = useCallback(async () => {
    // Only request if we should be active and don't already have a valid lock
    if (!isActiveRef.current) {
      return;
    }
    if (sentinelRef.current && !sentinelRef.current.released) {
      return;
    }
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) {
      return;
    }

    try {
      const sentinel = await navigator.wakeLock.request('screen');
      sentinelRef.current = sentinel;

      sentinel.addEventListener('release', () => {
        // Lock was released (e.g., page went to background, battery saver activated).
        // We'll re-acquire on visibilitychange if still active.
        if (sentinelRef.current === sentinel) {
          sentinelRef.current = null;
        }
      });
    } catch {
      // Wake lock request can fail (low battery, OS restrictions, etc.)
      // This is non-critical - the call still works, just risk of screen sleep.
    }
  }, []);

  const releaseWakeLock = useCallback(async () => {
    const sentinel = sentinelRef.current;
    if (sentinel && !sentinel.released) {
      try {
        await sentinel.release();
      } catch {
        // Release can fail if already released; safe to ignore.
      }
    }
    sentinelRef.current = null;
  }, []);

  // Acquire/release based on isActive state
  useEffect(() => {
    if (isActive) {
      requestWakeLock();
    } else {
      releaseWakeLock();
    }

    return () => {
      // Cleanup on unmount
      releaseWakeLock();
    };
  }, [isActive, requestWakeLock, releaseWakeLock]);

  // Re-acquire wake lock when page becomes visible again.
  // The Screen Wake Lock API automatically releases the lock when the page goes
  // to background (visibilityState === 'hidden'). We must re-request it when
  // the page returns to foreground.
  useEffect(() => {
    if (!isActive) {
      return;
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && isActiveRef.current) {
        requestWakeLock();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isActive, requestWakeLock]);
}
