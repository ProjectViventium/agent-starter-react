'use client';

/* SPDX-License-Identifier: MIT
 * Native SVG aura for the Viventium call page. This implementation is independently written;
 * it does not use the non-resale shader shipped with the upstream optional aura component.
 */
import { type ComponentProps, useId } from 'react';
import { cva } from 'class-variance-authority';
import type { LocalAudioTrack, RemoteAudioTrack } from 'livekit-client';
import {
  type AgentState,
  type TrackReferenceOrPlaceholder,
  useTrackVolume,
} from '@livekit/components-react';
import { cn } from '@/lib/shadcn/utils';

export const AgentAudioVisualizerAuraVariants = cva('aspect-square', {
  variants: {
    size: {
      icon: 'h-6',
      sm: 'h-14',
      md: 'h-28',
      lg: 'h-56',
      xl: 'h-112',
    },
  },
  defaultVariants: { size: 'md' },
});

export interface AgentAudioVisualizerAuraProps {
  size?: 'icon' | 'sm' | 'md' | 'lg' | 'xl';
  state?: AgentState;
  color?: `#${string}`;
  colorShift?: number;
  themeMode?: 'dark' | 'light';
  audioTrack?: LocalAudioTrack | RemoteAudioTrack | TrackReferenceOrPlaceholder;
  volume?: number;
}

export function AgentAudioVisualizerAura({
  size = 'lg',
  state = 'connecting',
  color = '#00A67E',
  colorShift = 0.05,
  themeMode,
  audioTrack,
  volume,
  ref,
  className,
  ...props
}: AgentAudioVisualizerAuraProps & ComponentProps<'div'>) {
  const gradient = useId();
  // The SDK accepts a real track or track reference and returns silence for an absent track.
  const measuredVolume = useTrackVolume(audioTrack as Parameters<typeof useTrackVolume>[0]);
  const sample = volume ?? measuredVolume;
  const level = Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0;
  const shift = Number.isFinite(colorShift) ? Math.max(0, Math.min(1, colorShift)) : 0;
  const speaking = state === 'speaking';
  const radius = 27 + (speaking ? level * 12 : 0);
  return (
    <div
      ref={ref}
      data-lk-state={state}
      data-theme={themeMode}
      className={cn(AgentAudioVisualizerAuraVariants({ size }), className)}
      {...props}
    >
      <svg viewBox="0 0 120 120" aria-hidden="true" className="h-full w-full overflow-visible">
        <defs>
          <radialGradient id={gradient}>
            <stop offset="0" stopColor={color} stopOpacity={themeMode === 'light' ? 0.35 : 0.65} />
            <stop offset="0.65" stopColor={color} stopOpacity="0.7" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx="60" cy="60" r={radius + 22} fill={`url(#${gradient})`} />
        <circle
          cx="60"
          cy="60"
          r={radius + 8}
          fill="none"
          stroke={color}
          strokeOpacity={0.25 + shift * 0.3}
          strokeWidth="2"
        />
        <circle
          cx="60"
          cy="60"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="3"
          className={
            state === 'connecting' || state === 'thinking'
              ? 'animate-pulse motion-reduce:animate-none'
              : undefined
          }
        />
      </svg>
    </div>
  );
}
