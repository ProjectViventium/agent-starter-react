'use client';

import { useCallback, useEffect, useState } from 'react';

export type DeviceSoundMode = 'standard' | 'earpiece';
export const DEVICE_SOUND_MODE_KEY = 'viventium.device-sound-mode.v1';

/** Device preference only. A running call keeps the mode captured at its first Start. */
export function useDeviceSoundMode() {
  const [mode, setMode] = useState<DeviceSoundMode>('standard');
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    try {
      setMode(
        window.localStorage.getItem(DEVICE_SOUND_MODE_KEY) === 'earpiece' ? 'earpiece' : 'standard'
      );
    } catch {
      // Storage is optional; the default call must still work.
    }
    setReady(true);
  }, []);
  const selectMode = useCallback((next: DeviceSoundMode) => {
    setMode(next);
    try {
      window.localStorage.setItem(DEVICE_SOUND_MODE_KEY, next);
      setNotice(null);
    } catch {
      setNotice('This browser could not save your sound choice. Select it again next time.');
    }
  }, []);
  return { mode, ready, notice, selectMode };
}

export type DeviceSoundSettings = ReturnType<typeof useDeviceSoundMode>;
