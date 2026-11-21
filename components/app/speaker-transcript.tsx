'use client';

/*
 * Who said what (CP-CMP-029, CP-CMP-030): the list of speech segments shown with the
 * transcript open, and the one-line caption shown with it closed.
 */
import * as React from 'react';
import { cn } from '@/lib/shadcn/utils';
import type { SpeakerSegmentV1 } from '@/lib/voice-events';

/** How often an unfinished caption may change on screen. */
const INTERIM_CAPTION_INTERVAL_MS = 750;

function displaySpeakerLabel(segment: SpeakerSegmentV1): string {
  return segment.uncertain || segment.speaker.attribution === 'unknown'
    ? 'Unknown'
    : segment.speaker.label;
}

const SpeakerSegment = React.memo(function SpeakerSegment({
  segment,
  position,
  total,
  className,
}: {
  segment: SpeakerSegmentV1;
  position: number;
  total: number;
  className?: string;
}) {
  const qualifiers = [
    segment.overlap ? 'Overlapping' : null,
    segment.uncertain ? 'uncertain' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <li
      aria-posinset={position}
      aria-setsize={total}
      className={cn(
        'flex flex-col gap-1 [contain-intrinsic-size:auto_4rem] [content-visibility:auto]',
        className
      )}
    >
      <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
        <strong className="text-foreground rounded-full border px-2 py-0.5">
          {displaySpeakerLabel(segment)}
        </strong>
        {segment.revision > 1 ? <span>Updated</span> : null}
        {qualifiers ? <span>{qualifiers}</span> : null}
      </div>
      <p className="max-w-4/5 text-sm leading-6">{segment.text}</p>
    </li>
  );
});

/**
 * Every speech segment the page holds, oldest first. The page holds a bounded number
 * (`MAX_RETAINED_SPEAKER_SEGMENTS`); rows off screen are skipped by the browser
 * (`content-visibility`), so there is no window of its own to manage. Earlier and later pages
 * are requested by the transcript when the reader reaches either end.
 */
export function SpeakerTranscript({
  segments,
  loadingOlder = false,
  loadingNewer = false,
  className,
}: {
  segments: SpeakerSegmentV1[];
  loadingOlder?: boolean;
  loadingNewer?: boolean;
  className?: string;
}) {
  if (segments.length === 0) {
    return null;
  }
  return (
    <div className={className}>
      {loadingOlder ? (
        <p role="status" className="text-muted-foreground mb-2 text-center text-xs">
          Loading earlier speakers…
        </p>
      ) : null}
      <ol aria-label="Speaker transcript" className="space-y-3">
        {segments.map((segment, index) => (
          <SpeakerSegment
            key={segment.segmentId}
            segment={segment}
            position={index + 1}
            total={segments.length}
          />
        ))}
      </ol>
      {loadingNewer ? (
        <p role="status" className="text-muted-foreground mt-2 text-center text-xs">
          Loading newer speakers…
        </p>
      ) : null}
    </div>
  );
}

/** The newest speaker and their words, in one line above the controls. */
export function LatestSpeakerCaption({
  segments,
  hidden = false,
  className,
}: {
  segments: SpeakerSegmentV1[];
  hidden?: boolean;
  className?: string;
}) {
  const latest = segments.at(-1) ?? null;
  const [displayed, setDisplayed] = React.useState(latest);
  const lastUpdateAtRef = React.useRef(0);

  React.useEffect(() => {
    if (!latest) {
      setDisplayed(null);
      return;
    }
    if (latest.isFinal) {
      lastUpdateAtRef.current = Date.now();
      setDisplayed(latest);
      return;
    }
    const elapsed = Date.now() - lastUpdateAtRef.current;
    const timer = window.setTimeout(
      () => {
        lastUpdateAtRef.current = Date.now();
        setDisplayed(latest);
      },
      Math.max(0, INTERIM_CAPTION_INTERVAL_MS - elapsed)
    );
    return () => window.clearTimeout(timer);
  }, [latest]);

  if (hidden || !displayed) {
    return null;
  }
  return (
    <p
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={cn(
        'bg-background/90 border-border mx-auto max-w-2xl truncate rounded-full border px-3 py-1.5 text-xs shadow-sm',
        className
      )}
    >
      <strong>{displaySpeakerLabel(displayed)}</strong>
      {displayed.overlap ? ' · overlapping' : ''} · {displayed.text}
    </p>
  );
}
