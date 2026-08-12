'use client';

import { useCallback, useState } from 'react';
import { callBrowserCapabilityHeaders } from '@/lib/call-browser-capability';
import { type VoiceTaskEventV1, parseTaskEvent } from '@/lib/voice-events';

const SAFE_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const MAX_INPUT_LENGTH = 8_000;
const TASK_ACTION_TIMEOUT_MS = 5_000;

type TaskActionPayload = {
  message: string | null;
  retryable: boolean;
  events: VoiceTaskEventV1[];
  malformedEvent: boolean;
};

async function readTaskActionPayload(
  response: Response,
  callSessionId: string,
  taskId: string
): Promise<TaskActionPayload> {
  const payload = (await response.json().catch(() => ({}))) as {
    message?: unknown;
    error?: unknown;
    retryable?: unknown;
    event?: unknown;
    previousEvent?: unknown;
    events?: unknown;
  };
  const hasEvent = Object.prototype.hasOwnProperty.call(payload, 'event');
  const hasPreviousEvent = Object.prototype.hasOwnProperty.call(payload, 'previousEvent');
  const hasEvents = Object.prototype.hasOwnProperty.call(payload, 'events');
  const candidates: unknown[] = [
    ...(hasPreviousEvent ? [payload.previousEvent] : []),
    ...(hasEvents && Array.isArray(payload.events) ? payload.events : []),
    ...(hasEvent ? [payload.event] : []),
  ];
  const parsedEvents: VoiceTaskEventV1[] = [];
  let malformedEvent = hasEvents && !Array.isArray(payload.events);
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const event = parseTaskEvent(candidate);
    if (
      !event ||
      event.callSessionId !== callSessionId ||
      (event.taskId !== taskId && event.parentTaskId !== taskId)
    ) {
      malformedEvent = true;
      continue;
    }
    const key = `${event.taskId}:${event.sequence}:${event.eventId}`;
    if (!seen.has(key)) {
      seen.add(key);
      parsedEvents.push(event);
    }
  }
  malformedEvent =
    malformedEvent ||
    ((hasEvent || hasPreviousEvent || hasEvents) && parsedEvents.length === 0) ||
    (response.ok && parsedEvents.length === 0);
  if (typeof payload.message === 'string' && payload.message.trim()) {
    return {
      message: payload.message.trim().slice(0, 2_000),
      retryable: payload.retryable === true,
      events: parsedEvents,
      malformedEvent,
    };
  }
  if (typeof payload.error === 'string' && payload.error.trim()) {
    return {
      message: payload.error.trim().slice(0, 2_000),
      retryable: payload.retryable === true,
      events: parsedEvents,
      malformedEvent,
    };
  }
  return {
    message: response.ok
      ? null
      : `Task action failed (${response.status}). No action was confirmed.`,
    retryable: response.status >= 500,
    events: parsedEvents,
    malformedEvent,
  };
}

export function useCallTaskActions(
  callSessionId: string | null,
  onTaskEvent?: (event: VoiceTaskEventV1) => void
) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionRetryable, setActionRetryable] = useState(false);
  const [pendingTaskIds, setPendingTaskIds] = useState<Set<string>>(() => new Set());

  const request = useCallback(
    async (taskId: string, action: 'cancel' | 'retry' | 'input', input?: string) => {
      if (!callSessionId || !SAFE_ID.test(callSessionId) || !SAFE_ID.test(taskId)) {
        setActionError('This task action is not available for the current call.');
        setActionRetryable(false);
        return false;
      }
      const normalizedInput = input?.trim();
      if (action === 'input' && (!normalizedInput || normalizedInput.length > MAX_INPUT_LENGTH)) {
        setActionError('Enter a response between 1 and 8,000 characters.');
        setActionRetryable(false);
        return false;
      }

      setActionError(null);
      setActionRetryable(false);
      setPendingTaskIds((current) => new Set(current).add(taskId));
      const controller = new AbortController();
      let timedOut = false;
      const timeoutId = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, TASK_ACTION_TIMEOUT_MS);
      try {
        const response = await fetch(`/api/call-tasks/${encodeURIComponent(taskId)}/${action}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...callBrowserCapabilityHeaders(callSessionId),
          },
          body: JSON.stringify({
            callSessionId,
            ...(action === 'input' ? { input: normalizedInput } : {}),
          }),
          cache: 'no-store',
          signal: controller.signal,
        });
        const payload = await readTaskActionPayload(response, callSessionId, taskId);
        payload.events.forEach((event) => onTaskEvent?.(event));
        if (payload.malformedEvent) {
          setActionError('The task runtime returned invalid task state. Live recovery will retry.');
          setActionRetryable(true);
          return false;
        }
        if (!response.ok) {
          const issue = payload;
          setActionError(
            issue.message || `Task action failed (${response.status}). No action was confirmed.`
          );
          setActionRetryable(issue.retryable);
          return false;
        }
        return true;
      } catch (error) {
        if (timedOut) {
          setActionError(
            'The task runtime did not respond in time. No action was confirmed; you can retry safely.'
          );
          setActionRetryable(true);
        } else {
          setActionError(
            'Viventium could not reach the task runtime. No action was confirmed; your call is still connected.'
          );
          setActionRetryable(error instanceof TypeError);
        }
        return false;
      } finally {
        window.clearTimeout(timeoutId);
        setPendingTaskIds((current) => {
          const next = new Set(current);
          next.delete(taskId);
          return next;
        });
      }
    },
    [callSessionId, onTaskEvent]
  );

  return {
    actionError,
    actionRetryable,
    pendingTaskIds,
    clearActionError: () => {
      setActionError(null);
      setActionRetryable(false);
    },
    cancel: (taskId: string) => request(taskId, 'cancel'),
    retry: (taskId: string) => request(taskId, 'retry'),
    submitInput: (taskId: string, input: string) => request(taskId, 'input', input),
  };
}
