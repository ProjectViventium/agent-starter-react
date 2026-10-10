'use client';

import React, { useEffect, useState } from 'react';
import { Button } from '@/components/livekit/button';
import {
  callBrowserCapabilityHeaders,
  readCallBrowserCapability,
  readCallOpenerOrigin,
} from '@/lib/call-browser-capability';
import { resolveLinkedChatHref, resolveLinkedChatOrigin } from '@/lib/call-handoff';
import { parseTaskEvent } from '@/lib/voice-events';
import type { VoiceTaskView } from '@/lib/voice-events';

/* VIVENTIUM START Saved file names stay visible until dismissal or the existing ended-call handoff. */
type ResultFilesReadReason =
  | 'missing_capability'
  | 'http_error'
  | 'unsupported_version'
  | 'invalid_event'
  | 'not_completed'
  | 'task_mismatch'
  | 'call_mismatch'
  | 'result_mismatch'
  | 'conversation_mismatch'
  | 'stale_sequence'
  | 'missing_filenames'
  | 'invalid_filenames'
  | 'valid'
  | 'disposed'
  | 'read_failed';

type ResultFilesReadTrace = {
  stage: 'fetch_started' | 'http_response' | 'validation' | 'accepted' | 'read_skipped' | 'read_failed';
  expectedSequence: number;
  httpStatus?: number;
  reason?: ResultFilesReadReason;
  returnedSequence?: number;
  returnedNameCount?: number;
  acceptedCount?: number;
};

function traceResultFilesRead(trace: ResultFilesReadTrace, warning = false) {
  const write = warning ? console.warn : console.debug;
  write('[ViventiumCallFiles]', JSON.stringify(trace));
}

function ResultFiles({ task }: { task: VoiceTaskView }) {
  const [filenames, setFilenames] = useState<string[]>([]);
  const [dismissed, setDismissed] = useState(false);
  const { callSessionId, taskId, resultMessageId, conversationId, sequence } = task;
  const chatHref = resolveLinkedChatHref(
    readCallOpenerOrigin(callSessionId) ??
      resolveLinkedChatOrigin(typeof document === 'undefined' ? '' : document.referrer),
    conversationId ?? null
  );

  useEffect(() => {
    if (!resultMessageId) return;
    if (!readCallBrowserCapability(callSessionId)) {
      traceResultFilesRead(
        { stage: 'read_skipped', expectedSequence: sequence, reason: 'missing_capability' },
        true
      );
      return;
    }
    const controller = new AbortController();
    let disposed = false;
    void (async () => {
      try {
        traceResultFilesRead({ stage: 'fetch_started', expectedSequence: sequence });
        const response = await fetch(
          `/api/call-tasks/${encodeURIComponent(taskId)}?callSessionId=${encodeURIComponent(callSessionId)}`,
          {
            cache: 'no-store',
            headers: callBrowserCapabilityHeaders(callSessionId),
            signal: controller.signal,
          }
        );
        const httpStatus = Number.isInteger(response.status) ? response.status : undefined;
        traceResultFilesRead({ stage: 'http_response', expectedSequence: sequence, httpStatus });
        if (!response.ok) {
          traceResultFilesRead(
            { stage: 'validation', expectedSequence: sequence, httpStatus, reason: 'http_error' },
            true
          );
          return;
        }
        const payload: { version?: number; event?: unknown; resultFilenames?: unknown } =
          await response.json();
        const event = parseTaskEvent(payload?.event);
        const names = payload?.resultFilenames;
        let reason: ResultFilesReadReason = 'valid';
        if (payload?.version !== 1) reason = 'unsupported_version';
        else if (!event) reason = 'invalid_event';
        else if (event.state !== 'completed') reason = 'not_completed';
        else if (event.taskId !== taskId) reason = 'task_mismatch';
        else if (event.callSessionId !== callSessionId) reason = 'call_mismatch';
        else if (event.resultMessageId !== resultMessageId) reason = 'result_mismatch';
        else if (event.conversationId !== conversationId) reason = 'conversation_mismatch';
        else if (event.sequence < sequence) reason = 'stale_sequence';
        else if (!Array.isArray(names)) reason = 'missing_filenames';
        else if (!names.every((name: unknown) => typeof name === 'string' && name.trim()))
          reason = 'invalid_filenames';
        traceResultFilesRead(
          {
            stage: 'validation',
            expectedSequence: sequence,
            httpStatus,
            reason,
            returnedSequence: event?.sequence,
            returnedNameCount: Array.isArray(names) ? names.length : undefined,
          },
          reason !== 'valid'
        );
        if (reason !== 'valid') return;
        if (!disposed) {
          setFilenames(names as string[]);
          traceResultFilesRead({
            stage: 'accepted',
            expectedSequence: sequence,
            returnedSequence: event?.sequence,
            acceptedCount: (names as string[]).length,
          });
        } else {
          traceResultFilesRead({ stage: 'read_skipped', expectedSequence: sequence, reason: 'disposed' });
        }
      } catch {
        traceResultFilesRead(
          {
            stage: disposed || controller.signal.aborted ? 'read_skipped' : 'read_failed',
            expectedSequence: sequence,
            reason: disposed || controller.signal.aborted ? 'disposed' : 'read_failed',
          },
          !disposed && !controller.signal.aborted
        );
        // Existing authenticated chat remains the durable file access path.
      }
    })();
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [callSessionId, taskId, resultMessageId, conversationId, sequence]);

  if (dismissed || !filenames.length || !chatHref) return null;
  return (
    <section
      aria-label="Files from this reply"
      className="bg-background/95 border-border mx-auto mb-2 w-full max-w-2xl rounded-xl border px-3 py-2 text-sm shadow-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <ul className="min-w-0 break-words">
          {filenames.map((filename, index) => (
            <li key={`${index}:${filename}`}>{filename}</li>
          ))}
        </ul>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss files"
        >
          Dismiss
        </Button>
      </div>
      <a
        href={chatHref}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 inline-block underline"
      >
        Open in chat
      </a>
    </section>
  );
}

export function CallResultFiles({
  callSessionId,
  tasks,
}: {
  callSessionId: string | null;
  tasks: VoiceTaskView[];
}) {
  return (
    <>
      {tasks
        .filter(
          (task) =>
            task.callSessionId === callSessionId &&
            task.state === 'completed' &&
            task.resultMessageId
        )
        .map((task) => (
          <ResultFiles
            key={JSON.stringify([
              task.callSessionId,
              task.taskId,
              task.conversationId,
              task.resultMessageId,
            ])}
            task={task}
          />
        ))}
    </>
  );
}
/* VIVENTIUM END */
