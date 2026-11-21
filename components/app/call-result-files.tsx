'use client';

/*
 * Result file cards (CP-CMP-035): when finished work produced files, list their names with a
 * way to open them in the chat. Files are never opened or downloaded on the call page.
 */
import { useEffect, useState } from 'react';
import { CallButton } from '@/components/app/call-button';
import {
  callBrowserCapabilityHeaders,
  readCallBrowserCapability,
  readCallOpenerOrigin,
} from '@/lib/call-browser-capability';
import { resolveLinkedChatHref, resolveLinkedChatOrigin } from '@/lib/call-handoff';
import { type VoiceTaskView, parseTaskEvent } from '@/lib/voice-events';

/**
 * The file names of a finished task, or the reason the server's reply is not accepted. The reply
 * counts only when it is about exactly this task, call, result message and conversation and is
 * not older than what the page already knows.
 */
function readResultFilenames(
  payload: { version?: unknown; event?: unknown; resultFilenames?: unknown } | null,
  task: Pick<
    VoiceTaskView,
    'taskId' | 'callSessionId' | 'resultMessageId' | 'conversationId' | 'sequence'
  >
): { names: string[] } | { rejected: string } {
  const event = parseTaskEvent(payload?.event);
  const names = payload?.resultFilenames;
  if (payload?.version !== 1) return { rejected: 'unsupported_version' };
  if (!event) return { rejected: 'invalid_event' };
  if (event.state !== 'completed') return { rejected: 'not_completed' };
  if (event.taskId !== task.taskId) return { rejected: 'task_mismatch' };
  if (event.callSessionId !== task.callSessionId) return { rejected: 'call_mismatch' };
  if (event.resultMessageId !== task.resultMessageId) return { rejected: 'result_mismatch' };
  if (event.conversationId !== task.conversationId) return { rejected: 'conversation_mismatch' };
  if (event.sequence < task.sequence) return { rejected: 'stale_sequence' };
  if (!Array.isArray(names)) return { rejected: 'missing_filenames' };
  if (!names.every((name: unknown) => typeof name === 'string' && name.trim())) {
    return { rejected: 'invalid_filenames' };
  }
  return { names: names as string[] };
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
    if (!resultMessageId || !readCallBrowserCapability(callSessionId)) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(
          `/api/call-tasks/${encodeURIComponent(taskId)}?callSessionId=${encodeURIComponent(callSessionId)}`,
          {
            cache: 'no-store',
            headers: callBrowserCapabilityHeaders(callSessionId),
            signal: controller.signal,
          }
        );
        const outcome = response.ok
          ? readResultFilenames(await response.json(), {
              taskId,
              callSessionId,
              resultMessageId,
              conversationId,
              sequence,
            })
          : { rejected: `http_${response.status}` };
        if (controller.signal.aborted) return;
        if ('rejected' in outcome) {
          // No names, addresses or ids: only why the read was not used.
          console.warn(`[Viventium] Result files were not shown (${outcome.rejected}).`);
          return;
        }
        setFilenames(outcome.names);
      } catch {
        if (!controller.signal.aborted) {
          console.warn('[Viventium] Result files were not shown (read_failed).');
        }
        // The files stay available in the chat.
      }
    })();
    return () => controller.abort();
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
        <CallButton
          size="sm"
          variant="outline"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss files"
        >
          Dismiss
        </CallButton>
      </div>
      <a
        href={chatHref}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 inline-block underline underline-offset-4"
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
