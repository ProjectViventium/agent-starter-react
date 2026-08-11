'use client';

import React from 'react';
import type { VoiceCallMode } from '@/hooks/useCallSessionState';
import { cn } from '@/lib/utils';

const MODES: ReadonlyArray<{ value: VoiceCallMode; label: string }> = [
  { value: 'call', label: 'Call' },
  { value: 'wing', label: 'Wing' },
  { value: 'listen_only', label: 'Listen-Only' },
];

export const LISTEN_ONLY_PRECONNECT_MESSAGE = 'Viventium is here with you, just listening.';

export type AccessibleCallStatus =
  | 'connecting'
  | 'listening'
  | 'speaking'
  | 'working'
  | 'needs input'
  | 'degraded'
  | 'failed'
  | 'ended';

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
      {MODES.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={mode === item.value}
          disabled={pending}
          onClick={() => {
            if (item.value !== mode) {
              onModeChange(item.value);
            }
          }}
          className={cn(
            'focus-visible:ring-ring/50 h-8 min-w-0 rounded-full px-2 text-[11px] font-semibold whitespace-nowrap transition-colors outline-none focus-visible:ring-[3px] disabled:opacity-50 motion-reduce:transition-none',
            mode === item.value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function CallStatusIndicator({
  status,
  mode,
  className,
}: {
  status: AccessibleCallStatus;
  mode: VoiceCallMode;
  className?: string;
}) {
  const modeLabel = mode === 'listen_only' ? 'Listen-Only' : mode === 'wing' ? 'Wing' : 'Call';
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
        {modeLabel} · {status}
      </span>
    </div>
  );
}
