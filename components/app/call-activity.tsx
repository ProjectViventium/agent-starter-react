'use client';

/*
 * Work cards (CP-CMP-026, 027, 028): what Viventium is doing in the background during the call,
 * with Cancel, Retry, Stop speech and a way to answer when the work asks a question.
 */
import * as React from 'react';
import { CircleStopIcon, RotateCwIcon } from 'lucide-react';
import { CallButton as Button } from '@/components/app/call-button';
import type { VoiceCallMode } from '@/hooks/useCallSessionState';
import { cn } from '@/lib/shadcn/utils';
import type {
  VoiceTaskEventV1,
  VoiceTaskSource,
  VoiceTaskState,
  VoiceTaskView,
} from '@/lib/voice-events';

/** A finished card leaves by itself after this long; failed ones stay until dismissed. */
const FINISHED_CARD_VISIBLE_MS = 8_000;

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

const TASK_STATE_LABELS: Record<VoiceTaskState, string> = {
  queued: 'Queued',
  running: 'Working',
  needs_input: 'Needs your input',
  recovering: 'Recovering',
  cancelling: 'Stopping',
  completed: 'Done',
  failed: 'Failed',
  cancelled_confirmed: 'Stopped',
  cancelled_unenforceable: 'Stop not confirmed',
};

const TERMINAL_TASK_STATES = new Set<VoiceTaskState>([
  'completed',
  'failed',
  'cancelled_confirmed',
  'cancelled_unenforceable',
]);

// Core's declared phase codes describe machinery; the state badge carries their user status.
const INTERNAL_TASK_PHASES = new Set([
  'cortex',
  'tool',
  'tool_completed',
  'delegated',
  'source',
  'follow_up',
  'agent',
  'owner_linked',
  'retried',
  'already_completed',
  'cancel_barrier_recovering',
]);

function taskPhase(task: VoiceTaskEventV1) {
  if (task.phase === 'starting') return 'Starting';
  return task.phase &&
    !Object.hasOwn(TASK_STATE_LABELS, task.phase) &&
    !INTERNAL_TASK_PHASES.has(task.phase)
    ? task.phase
    : TASK_STATE_LABELS[task.state];
}

function taskLabel(task: VoiceTaskEventV1) {
  return task.label || taskPhase(task);
}

function NativeQuestionInput({
  form,
  pending,
  onSubmit,
}: {
  form: NonNullable<VoiceTaskEventV1['needsInput']>['questionForm'];
  pending: boolean;
  onSubmit: (input: string) => void;
}) {
  const [answers, setAnswers] = React.useState<Record<string, string[]>>({});
  const [notes, setNotes] = React.useState<Record<string, string>>({});
  if (!form) return null;
  const valid = Object.keys(answers).length > 0;
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        const annotations = Object.fromEntries(
          Object.entries(answers)
            .filter(
              ([key, values]) =>
                values.includes('Other') && Object.hasOwn(notes, key) && notes[key]?.length > 0
            )
            .map(([key]) => [key, { notes: notes[key] }])
        );
        onSubmit(
          JSON.stringify({ answers, ...(Object.keys(annotations).length ? { annotations } : {}) })
        );
      }}
    >
      {form.questions.map((question) => (
        <fieldset key={question.key} disabled={pending} className="space-y-2">
          <legend className="text-sm">{question.label}</legend>
          {question.options.map((option) => (
            <label key={option.value} className="flex gap-2 text-sm">
              <input
                type={question.multiSelect ? 'checkbox' : 'radio'}
                name={question.key}
                checked={
                  (Object.hasOwn(answers, question.key)
                    ? answers[question.key]?.includes(option.value)
                    : false) || false
                }
                onChange={(event) =>
                  setAnswers((current) => {
                    const before = Object.hasOwn(current, question.key)
                      ? current[question.key]
                      : [];
                    const selected = event.target.checked
                      ? question.multiSelect
                        ? [...before, option.value]
                        : [option.value]
                      : before.filter((value) => value !== option.value);
                    const next = selected.length
                      ? { ...current, [question.key]: selected }
                      : { ...current };
                    if (!selected.length) delete next[question.key];
                    return next;
                  })
                }
              />
              {option.label}
            </label>
          ))}
          {Object.hasOwn(answers, question.key) && answers[question.key]?.includes('Other') && (
            <label className="block text-sm">
              Your answer
              <textarea
                aria-label={`Your answer: ${question.label}`}
                maxLength={8000}
                value={(Object.hasOwn(notes, question.key) ? notes[question.key] : '') || ''}
                onChange={(event) =>
                  setNotes((current) => ({ ...current, [question.key]: event.target.value }))
                }
                className="border-input bg-background w-full rounded-md border p-2"
              />
            </label>
          )}
        </fieldset>
      ))}
      <Button type="submit" size="sm" disabled={pending || !valid}>
        Send
      </Button>
    </form>
  );
}

function TaskItem({
  task,
  onCancel,
  onRetry,
  onInput,
  onDismiss,
  pending = false,
  stopSpeech = false,
}: {
  task: VoiceTaskView;
  onCancel?: (taskId: string, presentationRef?: string) => void;
  onRetry?: (taskId: string) => void;
  onInput?: (taskId: string, input: string) => void;
  onDismiss?: () => void;
  pending?: boolean;
  stopSpeech?: boolean;
}) {
  const [input, setInput] = React.useState('');
  const label = taskLabel(task);
  const progress = task.progress;
  const statusLabel =
    stopSpeech && task.state === 'completed' && task.presentation?.state === 'speaking'
      ? 'Speaking'
      : task.state === 'completed' && task.presentation?.state === 'stop_requested'
        ? 'Stopping speech'
        : TASK_STATE_LABELS[task.state];
  const phase = taskPhase(task);
  const showPhase = phase !== label && phase !== statusLabel;

  return (
    <li className="border-border/70 flex min-w-0 flex-col gap-2 border-b py-2 last:border-0">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{label}</p>
          {showPhase || progress ? (
            <p className="text-muted-foreground text-xs leading-5">
              {showPhase ? phase : null}
              {progress ? (
                <span>
                  {showPhase ? ' · ' : ''}
                  {progress.current} of {progress.total}
                  {progress.unit ? ` ${progress.unit}` : ''}
                </span>
              ) : null}
            </p>
          ) : null}
        </div>
        <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-2 py-1 font-mono text-[10px] uppercase">
          {statusLabel}
        </span>
      </div>

      {task.detail ? (
        <p className="text-muted-foreground text-xs leading-5">{task.detail}</p>
      ) : null}

      {task.error?.message && task.error.message !== task.detail ? (
        <p role="alert" className="text-destructive text-xs leading-5">
          {task.error.message}
        </p>
      ) : null}

      {onDismiss ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`Dismiss ${label}`}
          onClick={onDismiss}
        >
          Dismiss
        </Button>
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
          <p className="text-sm break-words whitespace-pre-wrap">{task.needsInput.prompt}</p>
          {task.needsInput.operationTitle &&
          task.needsInput.nativeInputRequest?.kind === 'permission' ? (
            <details key={task.needsInput.nativeInputRequest.requestFingerprint}>
              <summary className="cursor-pointer text-sm">Action details</summary>
              <p className="text-muted-foreground text-xs break-words whitespace-pre-wrap">
                {task.needsInput.operationTitle}
              </p>
            </details>
          ) : null}
          {onInput && task.needsInput.questionForm ? (
            <NativeQuestionInput
              key={
                task.needsInput.nativeInputRequest?.requestFingerprint ||
                JSON.stringify(task.needsInput.questionForm)
              }
              form={task.needsInput.questionForm}
              pending={pending}
              onSubmit={(value) => onInput(task.taskId, value)}
            />
          ) : onInput && task.needsInput.choices?.length ? (
            <div className="flex flex-wrap gap-2">
              {task.needsInput.choices.map((choice) => (
                <Button
                  key={choice.value}
                  type="button"
                  size="sm"
                  disabled={pending}
                  onClick={() => onInput(task.taskId, choice.value)}
                >
                  {choice.label}
                </Button>
              ))}
            </div>
          ) : onInput ? (
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

      {task.cancellable || task.retryable || stopSpeech ? (
        <div className="flex gap-2">
          {(task.cancellable || stopSpeech) && onCancel ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={stopSpeech ? `Stop speech for ${label}` : `Cancel ${label}`}
              onClick={() =>
                stopSpeech ? onCancel(task.taskId, task.presentation?.ref) : onCancel(task.taskId)
              }
              disabled={pending}
            >
              <CircleStopIcon aria-hidden="true" />
              {stopSpeech ? 'Stop speech' : 'Cancel'}
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
              <RotateCwIcon aria-hidden="true" />
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
  isAgentSpeaking = false,
  tasks,
  onCancel,
  onRetry,
  onInput,
  actionError,
  pendingTaskIds,
  className,
}: {
  mode?: VoiceCallMode;
  isAgentSpeaking?: boolean;
  tasks: VoiceTaskView[];
  onCancel?: (taskId: string, presentationRef?: string) => void;
  onRetry?: (taskId: string) => void;
  onInput?: (taskId: string, input: string) => void;
  actionError?: string | null;
  pendingTaskIds?: Set<string>;
  className?: string;
}) {
  const [hiddenTerminalTasks, setHiddenTerminalTasks] = React.useState<Set<string>>(
    () => new Set()
  );
  const latestPresentationTask = tasks.reduce<VoiceTaskView | null>(
    (latest, task) =>
      task.presentation &&
      (!latest?.presentation || task.presentation.startedAtMs > latest.presentation.startedAtMs)
        ? task
        : latest,
    null
  );
  const speakingTaskId =
    isAgentSpeaking &&
    latestPresentationTask?.state === 'completed' &&
    (latestPresentationTask.presentation?.state === 'speaking' ||
      latestPresentationTask.presentation?.state === 'stop_requested')
      ? latestPresentationTask.taskId
      : null;
  const stoppingTaskId =
    latestPresentationTask?.state === 'completed' &&
    latestPresentationTask.presentation?.state === 'stop_requested'
      ? latestPresentationTask.taskId
      : null;
  const visiblePresentationTaskId = speakingTaskId || stoppingTaskId;
  React.useEffect(() => {
    const timers = tasks
      .filter(
        (task) =>
          TERMINAL_TASK_STATES.has(task.state) &&
          task.taskId !== visiblePresentationTaskId &&
          !task.error &&
          task.state !== 'cancelled_unenforceable' &&
          !hiddenTerminalTasks.has(task.taskId)
      )
      .map((task) =>
        window.setTimeout(() => {
          setHiddenTerminalTasks((current) => new Set(current).add(task.taskId));
        }, FINISHED_CARD_VISIBLE_MS)
      );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [hiddenTerminalTasks, tasks, visiblePresentationTaskId]);
  const visibleTasks = tasks.filter(
    (task) => task.taskId === visiblePresentationTaskId || !hiddenTerminalTasks.has(task.taskId)
  );
  const liveSummary = visibleTasks
    .map((task) => {
      const progress = task.progress
        ? ` ${task.progress.current} of ${task.progress.total}${task.progress.unit ? ` ${task.progress.unit}` : ''}`
        : '';
      return `${taskLabel(task)} ${taskPhase(task)}${progress}`;
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
            onDismiss={
              task.taskId !== visiblePresentationTaskId &&
              (task.error || task.state === 'cancelled_unenforceable') &&
              TERMINAL_TASK_STATES.has(task.state)
                ? () => setHiddenTerminalTasks((current) => new Set(current).add(task.taskId))
                : undefined
            }
            pending={pendingTaskIds?.has(task.taskId) === true}
            stopSpeech={task.taskId === speakingTaskId}
          />
        ))}
      </ul>
    </section>
  );
}
