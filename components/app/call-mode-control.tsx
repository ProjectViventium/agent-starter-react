'use client';

import { EarIcon, FeatherIcon, type LucideIcon, PhoneIcon } from 'lucide-react';
import type { VoiceCallMode } from '@/hooks/useCallSessionState';
import { cn } from '@/lib/shadcn/utils';

const MODES: ReadonlyArray<{
  value: VoiceCallMode;
  label: string;
  hint: string;
  Icon: LucideIcon;
}> = [
  { value: 'call', label: 'Call', hint: 'Viventium answers when you speak', Icon: PhoneIcon },
  {
    value: 'wing',
    label: 'Wing',
    hint: 'Viventium joins in when it is addressed',
    Icon: FeatherIcon,
  },
  {
    value: 'listen_only',
    label: 'Listen-Only',
    hint: 'Viventium listens and stays quiet',
    Icon: EarIcon,
  },
];

export const LISTEN_ONLY_PRECONNECT_MESSAGE = 'Viventium is here with you, just listening.';

export function callModeLabel(mode: VoiceCallMode): string {
  return MODES.find((item) => item.value === mode)?.label ?? 'Call';
}

export type AccessibleCallStatus =
  | 'connecting'
  | 'listening'
  | 'speaking'
  | 'working'
  | 'needs input'
  | 'degraded'
  | 'failed'
  | 'ended';

/** Call / Wing / Listen-Only: one press changes the mode (CP-CMP-017). */
export function CallModeControl({
  mode,
  pending,
  onModeChange,
  className,
}: {
  mode: VoiceCallMode;
  pending: boolean;
  onModeChange: (mode: VoiceCallMode) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label="Call mode"
      aria-busy={pending}
      className={cn('bg-muted grid min-w-0 grid-cols-3 rounded-full p-1', className)}
    >
      {MODES.map(({ value, label, hint, Icon }) => (
        <button
          key={value}
          type="button"
          title={hint}
          aria-pressed={mode === value}
          disabled={pending}
          onClick={() => {
            if (value !== mode) {
              onModeChange(value);
            }
          }}
          className={cn(
            'focus-visible:ring-ring/50 flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-full px-2 text-[11px] font-semibold whitespace-nowrap transition-colors outline-none focus-visible:ring-[3px] disabled:opacity-50 motion-reduce:transition-none',
            mode === value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Icon aria-hidden="true" className="size-3.5 shrink-0" />
          {label}
        </button>
      ))}
    </div>
  );
}

/** "Wing · listening": the one place the mode and state of the call are stated (CP-CMP-016). */
export function CallStatusIndicator({
  status,
  mode,
  className,
}: {
  status: AccessibleCallStatus;
  mode: VoiceCallMode;
  className?: string;
}) {
  const isLive = status !== 'failed' && status !== 'ended';
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`Call status: ${status}`}
      className={cn(
        'text-muted-foreground inline-flex min-w-0 items-center gap-2 text-xs font-medium capitalize',
        className
      )}
    >
      <span
        data-testid="call-status-dot"
        aria-hidden="true"
        className={cn(
          'size-2 shrink-0 rounded-full transition-colors motion-reduce:transition-none',
          isLive ? 'bg-emerald-500' : status === 'failed' ? 'bg-destructive' : 'bg-muted-foreground'
        )}
      />
      <span className="truncate">
        {callModeLabel(mode)} · {status}
      </span>
    </div>
  );
}
