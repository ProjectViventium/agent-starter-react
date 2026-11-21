'use client';

import { HeadphonesIcon, Volume2Icon } from 'lucide-react';
import type { DeviceSoundMode, DeviceSoundSettings } from '@/hooks/useDeviceSoundMode';
import { cn } from '@/lib/shadcn/utils';

const SOUND_MODES = [
  { mode: 'standard', label: 'Speaker', Icon: Volume2Icon },
  { mode: 'earpiece', label: 'Earpiece / headphones', Icon: HeadphonesIcon },
] as const;

/**
 * Sound on this device (CP-CMP-042): Speaker, or Earpiece / headphones for phones whose speaker
 * crackles. The choice is remembered on the device and fixed for a call when it starts.
 */
export function DeviceSoundControl({
  deviceSound,
  activeSoundMode,
}: {
  deviceSound: DeviceSoundSettings;
  /** The mode the running call uses; `null` when no call has started. */
  activeSoundMode?: DeviceSoundMode | null;
}) {
  return (
    <fieldset>
      <legend className="mb-2 text-sm font-semibold">Sound on this device</legend>
      <div className="grid grid-cols-2 gap-2">
        {SOUND_MODES.map(({ mode, label, Icon }) => {
          const selected = deviceSound.mode === mode;
          return (
            <button
              key={mode}
              type="button"
              aria-pressed={selected}
              disabled={!deviceSound.ready}
              onClick={() => deviceSound.selectMode(mode)}
              className={cn(
                'focus-visible:ring-ring/50 flex min-h-11 items-center justify-center gap-2 rounded-full border px-3 py-2 text-sm outline-none focus-visible:ring-[3px]',
                selected
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border text-muted-foreground hover:bg-muted'
              )}
            >
              <Icon aria-hidden="true" className="size-4 shrink-0" />
              {label}
            </button>
          );
        })}
      </div>
      {deviceSound.mode === 'earpiece' && (
        <p className="text-muted-foreground mt-2 text-xs">
          For phone crackle. Hold to your ear or use headphones.
        </p>
      )}
      {activeSoundMode && deviceSound.mode !== activeSoundMode && (
        <p role="status" className="mt-2 text-sm">
          Saved for your next call.
        </p>
      )}
      {deviceSound.notice && (
        <p role="status" className="mt-2 text-sm">
          {deviceSound.notice}
        </p>
      )}
    </fieldset>
  );
}
