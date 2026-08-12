'use client';

import * as React from 'react';
import { ArrowClockwiseIcon, StopCircleIcon } from '@phosphor-icons/react/dist/ssr';
import { Button } from '@/components/livekit/button';
import type { VoiceCallMode } from '@/hooks/useCallSessionState';
import { cn } from '@/lib/utils';
import type {
  SpeakerSegmentV1,
  VoiceTaskEventV1,
  VoiceTaskSource,
  VoiceTaskView,
} from '@/lib/voice-events';

const INITIAL_SPEAKER_WINDOW = 160;
const MAX_RENDERED_SPEAKER_SEGMENTS = 512;
const SPEAKER_WINDOW_STEP = 120;
const SPEAKER_WINDOW_EDGE_PX = 72;

function sourceHref(source: VoiceTaskSource | undefined): string | null {
  if (!source?.url) {
    return null;
  }
  try {
    const url = new URL(source.url);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function taskLabel(task: VoiceTaskEventV1) {
  return task.label || task.phase || 'Active task';
}

function TaskItem({
  task,
  onCancel,
  onRetry,
  onInput,
  pending = false,
}: {
  task: VoiceTaskView;
  onCancel?: (taskId: string) => void;
  onRetry?: (taskId: string) => void;
  onInput?: (taskId: string, input: string) => void;
  pending?: boolean;
}) {
  const [input, setInput] = React.useState('');
  const label = taskLabel(task);
  const progress = task.progress;
  const statusLabel = task.state.replaceAll('_', ' ');

  return (
    <li className="border-border/70 flex min-w-0 flex-col gap-2 border-b py-2 last:border-0">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{label}</p>
          <p className="text-muted-foreground text-xs leading-5">
            {task.phase || statusLabel}
            {progress ? (
              <span>
                {' · '}
                {progress.current} of {progress.total}
                {progress.unit ? ` ${progress.unit}` : ''}
              </span>
            ) : null}
          </p>
        </div>
        <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-2 py-1 font-mono text-[10px] uppercase">
          {statusLabel}
        </span>
      </div>

      {task.detail ? (
        <p className="text-muted-foreground text-xs leading-5">{task.detail}</p>
      ) : null}

      {task.sources.length > 0 ? (
        <ul aria-label={`Sources for ${label}`} className="flex flex-wrap gap-x-3 gap-y-1">
          {task.sources.map((source, index) => {
            const href = sourceHref(source);
            const title = source.title || source.provider || `Source ${index + 1}`;
            return (
              <li key={source.id || source.url || `${title}-${index}`}>
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-foreground text-xs underline underline-offset-4"
                  >
                    {title}
                  </a>
                ) : (
                  <span className="text-muted-foreground text-xs">{title}</span>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}

      {task.state === 'needs_input' && task.needsInput?.prompt ? (
        <div className="space-y-2">
          <p className="text-sm">{task.needsInput.prompt}</p>
          {onInput ? (
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const value = input.trim();
                if (value) {
                  onInput(task.taskId, value);
                  setInput('');
                }
              }}
            >
              <label htmlFor={`task-input-${task.taskId}`} className="sr-only">
                Answer for {label}
              </label>
              <input
                id={`task-input-${task.taskId}`}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                className="border-input bg-background h-9 min-w-0 grow rounded-full border px-3 text-sm"
              />
              <Button type="submit" size="sm" disabled={!input.trim() || pending}>
                Send
              </Button>
            </form>
          ) : null}
        </div>
      ) : null}

      {task.cancellable || task.retryable ? (
        <div className="flex gap-2">
          {task.cancellable && onCancel ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={`Cancel ${label}`}
              onClick={() => onCancel(task.taskId)}
              disabled={pending}
            >
              <StopCircleIcon weight="bold" />
              Cancel
            </Button>
          ) : null}
          {task.retryable && onRetry ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={`Retry ${label}`}
              onClick={() => onRetry(task.taskId)}
              disabled={pending}
            >
              <ArrowClockwiseIcon weight="bold" />
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function CallActivity({
  mode = 'call',
  tasks,
  onCancel,
  onRetry,
  onInput,
  actionError,
  pendingTaskIds,
  className,
}: {
  mode?: VoiceCallMode;
  tasks: VoiceTaskView[];
  onCancel?: (taskId: string) => void;
  onRetry?: (taskId: string) => void;
  onInput?: (taskId: string, input: string) => void;
  actionError?: string | null;
  pendingTaskIds?: Set<string>;
  className?: string;
}) {
  const [hiddenTerminalTasks, setHiddenTerminalTasks] = React.useState<Set<string>>(
    () => new Set()
  );
  React.useEffect(() => {
    const terminalStates = new Set([
      'completed',
      'failed',
      'cancelled_confirmed',
      'cancelled_unenforceable',
    ]);
    const timers = tasks
      .filter((task) => terminalStates.has(task.state) && !hiddenTerminalTasks.has(task.taskId))
      .map((task) =>
        window.setTimeout(() => {
          setHiddenTerminalTasks((current) => new Set(current).add(task.taskId));
        }, 8_000)
      );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [hiddenTerminalTasks, tasks]);
  const visibleTasks = tasks.filter((task) => !hiddenTerminalTasks.has(task.taskId));
  const liveSummary = visibleTasks
    .map((task) => {
      const progress = task.progress
        ? ` ${task.progress.current} of ${task.progress.total}${task.progress.unit ? ` ${task.progress.unit}` : ''}`
        : '';
      return `${taskLabel(task)} ${task.phase || task.state.replaceAll('_', ' ')}${progress}`;
    })
    .join('. ');

  if (visibleTasks.length === 0 && !actionError) {
    return null;
  }
  return (
    <section
      aria-label="Call activity"
      className={cn(
        'bg-background/95 border-border mx-auto w-full max-w-2xl rounded-xl border px-3 shadow-sm backdrop-blur-sm',
        className
      )}
    >
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label="Call activity update"
        className="sr-only"
      >
        {liveSummary}
      </p>
      {actionError ? (
        <p role="alert" className="text-destructive border-border border-b py-2 text-xs">
          {actionError}
        </p>
      ) : null}
      <ul>
        {visibleTasks.map((task) => (
          <TaskItem
            key={task.taskId}
            task={task}
            onCancel={onCancel}
            onRetry={mode === 'listen_only' ? undefined : onRetry}
            onInput={mode === 'listen_only' ? undefined : onInput}
            pending={pendingTaskIds?.has(task.taskId) === true}
          />
        ))}
      </ul>
    </section>
  );
}

export function SpeakerTranscript({
  segments,
  scrollContainerRef,
  hasOlder = false,
  loadingOlder = false,
  onLoadOlder,
  hasNewer = false,
  loadingNewer = false,
  onLoadNewer,
  className,
}: {
  segments: SpeakerSegmentV1[];
  scrollContainerRef?: React.RefObject<HTMLElement | null>;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  hasNewer?: boolean;
  loadingNewer?: boolean;
  onLoadNewer?: () => void;
  className?: string;
}) {
  const transcriptRef = React.useRef<HTMLOListElement>(null);
  const previousSegmentsRef = React.useRef(segments);
  const [windowRange, setWindowRange] = React.useState(() => ({
    start: Math.max(0, segments.length - INITIAL_SPEAKER_WINDOW),
    end: segments.length,
    followingLatest: true,
  }));

  React.useEffect(() => {
    const previousSegments = previousSegmentsRef.current;
    setWindowRange((current) => {
      const currentSpan = Math.min(
        MAX_RENDERED_SPEAKER_SEGMENTS,
        Math.max(INITIAL_SPEAKER_WINDOW, current.end - current.start)
      );
      if (current.followingLatest) {
        const end = segments.length;
        const start = Math.max(0, end - currentSpan);
        if (start === current.start && end === current.end) {
          return current;
        }
        return { start, end, followingLatest: true };
      }

      const anchorId = previousSegments[current.start]?.segmentId;
      const anchorIndex = anchorId
        ? segments.findIndex((segment) => segment.segmentId === anchorId)
        : -1;
      const start = Math.max(
        0,
        Math.min(anchorIndex >= 0 ? anchorIndex : current.start, Math.max(0, segments.length - 1))
      );
      const end = Math.min(segments.length, start + currentSpan);
      if (start === current.start && end === current.end) {
        return current;
      }
      return { start, end, followingLatest: false };
    });
    previousSegmentsRef.current = segments;
  }, [segments]);

  React.useEffect(() => {
    const container = scrollContainerRef?.current;
    const transcript = transcriptRef.current;
    if (!container || !transcript) {
      return;
    }
    const handleScroll = () => {
      const containerRect = container.getBoundingClientRect();
      const transcriptRect = transcript.getBoundingClientRect();
      const transcriptTopIsVisible =
        transcriptRect.top >= containerRect.top - SPEAKER_WINDOW_EDGE_PX &&
        transcriptRect.top <= containerRect.bottom;
      const transcriptBottomIsVisible =
        transcriptRect.bottom <= containerRect.bottom + SPEAKER_WINDOW_EDGE_PX &&
        transcriptRect.bottom >= containerRect.top;

      if (transcriptTopIsVisible) {
        setWindowRange((current) => {
          if (current.start === 0) {
            if (hasOlder && !loadingOlder) onLoadOlder?.();
            return current;
          }
          const start = Math.max(0, current.start - SPEAKER_WINDOW_STEP);
          const end = Math.min(current.end, start + MAX_RENDERED_SPEAKER_SEGMENTS);
          return { start, end, followingLatest: false };
        });
        return;
      }
      if (transcriptBottomIsVisible) {
        setWindowRange((current) => {
          if (current.end >= segments.length) {
            if (hasNewer && !loadingNewer) onLoadNewer?.();
            return current;
          }
          const end = Math.min(segments.length, current.end + SPEAKER_WINDOW_STEP);
          const start = Math.max(0, end - MAX_RENDERED_SPEAKER_SEGMENTS);
          return { start, end, followingLatest: end === segments.length };
        });
      }
    };
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [
    hasNewer,
    hasOlder,
    loadingNewer,
    loadingOlder,
    onLoadNewer,
    onLoadOlder,
    scrollContainerRef,
    segments.length,
  ]);

  if (segments.length === 0) {
    return null;
  }
  const boundedStart = Math.min(windowRange.start, Math.max(0, segments.length - 1));
  const boundedEnd = Math.max(boundedStart, Math.min(windowRange.end, segments.length));
  const visibleSegments = segments.slice(boundedStart, boundedEnd);
  const descriptionId = 'speaker-transcript-window-description';
  return (
    <>
      {loadingOlder ? (
        <p role="status" className="text-muted-foreground mb-2 text-center text-xs">
          Loading earlier speakers…
        </p>
      ) : null}
      {loadingNewer ? (
        <p role="status" className="text-muted-foreground mb-2 text-center text-xs">
          Loading newer speakers…
        </p>
      ) : null}
      <p id={descriptionId} className="sr-only">
        Showing transcript items {boundedStart + 1} through {boundedEnd} of {segments.length}.
        Scroll naturally to hear earlier or later speakers.
      </p>
      <ol
        ref={transcriptRef}
        aria-label="Speaker transcript"
        aria-describedby={descriptionId}
        className={cn('space-y-3', className)}
      >
        {visibleSegments.map((segment, visibleIndex) => {
          const label = displaySpeakerLabel(segment);
          const qualifiers = [
            segment.overlap ? 'Overlapping' : null,
            segment.uncertain ? 'uncertain' : null,
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            <li
              key={segment.segmentId}
              aria-posinset={boundedStart + visibleIndex + 1}
              aria-setsize={segments.length}
              className="flex flex-col gap-1"
            >
              <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                <strong className="text-foreground rounded-full border px-2 py-0.5">{label}</strong>
                {segment.revision > 1 ? <span>Updated</span> : null}
                {qualifiers ? <span>{qualifiers}</span> : null}
              </div>
              <p className="max-w-4/5 text-sm leading-6">{segment.text}</p>
            </li>
          );
        })}
      </ol>
    </>
  );
}

function displaySpeakerLabel(segment: SpeakerSegmentV1): string {
  return segment.uncertain || segment.speaker.attribution === 'unknown'
    ? 'Unknown'
    : segment.speaker.label;
}

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
    const delay = Math.max(0, 750 - elapsed);
    const timer = window.setTimeout(() => {
      lastUpdateAtRef.current = Date.now();
      setDisplayed(latest);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [latest]);

  if (hidden || !displayed) {
    return null;
  }
  const overlap = displayed.overlap ? ' · overlapping' : '';
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
      {overlap} · {displayed.text}
    </p>
  );
}
