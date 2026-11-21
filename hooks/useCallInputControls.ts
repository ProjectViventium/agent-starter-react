'use client';

/*
 * Per-call microphone mute memory (CP-CMP-038, seam S2).
 *
 * Upstream's `useInputControls` remembers one microphone preference for the whole browser.
 * A Viventium call also remembers the choice for this call only, so a reload or reconnect of a
 * call the user muted starts muted, while a new call starts unmuted (`useCallStart` reads it).
 */
import { useCallback } from 'react';
import {
  type UseInputControlsProps,
  type UseInputControlsReturn,
  useInputControls,
} from '@/hooks/agents-ui/use-agent-control-bar';
import { saveCallMicrophoneEnabled } from '@/lib/microphone-start';

export type UseCallInputControlsProps = UseInputControlsProps & {
  callSessionId?: string | null;
};

export function useCallInputControls({
  callSessionId,
  saveUserChoices = true,
  ...props
}: UseCallInputControlsProps = {}): UseInputControlsReturn {
  const controls = useInputControls({ saveUserChoices, ...props });
  const { microphoneToggle } = controls;

  const toggleMicrophone = useCallback(
    async (enabled?: boolean) => {
      // Save what the user asked for, and only once the microphone really changed.
      const requested = enabled ?? !microphoneToggle.enabled;
      await microphoneToggle.toggle(enabled);
      if (saveUserChoices) saveCallMicrophoneEnabled(callSessionId, requested);
    },
    [callSessionId, microphoneToggle, saveUserChoices]
  );

  return { ...controls, microphoneToggle: { ...microphoneToggle, toggle: toggleMicrophone } };
}
