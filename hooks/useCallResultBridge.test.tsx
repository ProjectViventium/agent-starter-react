import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useCallResultBridge } from '@/hooks/useCallResultBridge';
import type { VoiceTaskView } from '@/lib/voice-events';

const originalReferrer = document.referrer;
const originalOpener = window.opener;

afterEach(() => {
  Object.defineProperty(document, 'referrer', {
    configurable: true,
    value: originalReferrer,
  });
  Object.defineProperty(window, 'opener', {
    configurable: true,
    value: originalOpener,
  });
});

function resultTask(): VoiceTaskView {
  return {
    version: 1,
    eventId: 'event-1',
    sequence: 2,
    emittedAt: '2026-08-09T12:00:00.000Z',
    callSessionId: 'call-1',
    conversationId: 'conversation-1',
    taskId: 'task-1',
    type: 'result',
    state: 'completed',
    cancellable: false,
    retryable: false,
    resultMessageId: 'message-1',
    firstEmittedAt: '2026-08-09T11:59:59.000Z',
    sources: [],
  };
}

describe('useCallResultBridge', () => {
  it('emits the strict linked-chat result and ended contract to the exact opener origin', async () => {
    const postMessage = vi.fn();
    Object.defineProperty(document, 'referrer', {
      configurable: true,
      value: 'https://chat.example.com/c/conversation-1',
    });
    Object.defineProperty(window, 'opener', {
      configurable: true,
      value: { postMessage },
    });
    const { result } = renderHook(() =>
      useCallResultBridge({
        callSessionId: 'call-1',
        conversationId: 'conversation-1',
        tasks: [resultTask()],
      })
    );
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    expect(postMessage).toHaveBeenNthCalledWith(
      1,
      {
        version: 1,
        type: 'viventium.call.event.v1',
        event: 'result',
        callSessionId: 'call-1',
        conversationId: 'conversation-1',
        resultMessageId: 'message-1',
      },
      'https://chat.example.com'
    );

    act(() => {
      expect(result.current()).toBe(true);
    });
    expect(postMessage).toHaveBeenNthCalledWith(
      2,
      {
        version: 1,
        type: 'viventium.call.event.v1',
        event: 'ended',
        callSessionId: 'call-1',
        conversationId: 'conversation-1',
      },
      'https://chat.example.com'
    );
  });

  it('notifies a trusted opener that a no-task new call ended without inventing a conversation', async () => {
    const postMessage = vi.fn();
    Object.defineProperty(document, 'referrer', {
      configurable: true,
      value: 'https://chat.example.com/new',
    });
    Object.defineProperty(window, 'opener', {
      configurable: true,
      value: { postMessage },
    });
    const { result } = renderHook(() =>
      useCallResultBridge({
        callSessionId: 'call-empty',
        conversationId: null,
        tasks: [],
      })
    );
    await waitFor(() => expect(postMessage).not.toHaveBeenCalled());

    act(() => {
      expect(result.current()).toBe(true);
    });
    expect(postMessage).toHaveBeenCalledWith(
      {
        version: 1,
        type: 'viventium.call.event.v1',
        event: 'ended',
        callSessionId: 'call-empty',
      },
      'https://chat.example.com'
    );
  });
});

afterEach(() => window.sessionStorage.clear());

describe('linked chat presentation', () => {
  it('exposes the normal route using the retained opener origin without leaking the call capability', async () => {
    window.sessionStorage.setItem(
      'viventium.call.opener-origin.v1:call-1',
      'https://chat.example.test'
    );
    Object.defineProperty(document, 'referrer', {
      configurable: true,
      value: '',
    });
    const onLinkedChatHrefChange = vi.fn();
    renderHook(() =>
      useCallResultBridge({
        callSessionId: 'call-1',
        conversationId: 'conversation-1',
        tasks: [],
        onLinkedChatHrefChange,
      })
    );
    await waitFor(() =>
      expect(onLinkedChatHrefChange).toHaveBeenLastCalledWith(
        'https://chat.example.test/c/conversation-1'
      )
    );
  });

  it('updates the route from the canonical current-call result and retains it when the card expires', async () => {
    Object.defineProperty(document, 'referrer', {
      configurable: true,
      value: 'https://chat.example.test/c/conversation-1',
    });
    const onLinkedChatHrefChange = vi.fn();
    const { rerender } = renderHook(
      ({ tasks }) =>
        useCallResultBridge({
          callSessionId: 'call-1',
          conversationId: 'conversation-1',
          tasks,
          onLinkedChatHrefChange,
        }),
      { initialProps: { tasks: [] as VoiceTaskView[] } }
    );
    rerender({
      tasks: [{ ...resultTask(), conversationId: 'conversation-2' }],
    });
    await waitFor(() =>
      expect(onLinkedChatHrefChange).toHaveBeenLastCalledWith(
        'https://chat.example.test/c/conversation-2'
      )
    );
    rerender({ tasks: [] });
    await waitFor(() =>
      expect(onLinkedChatHrefChange).toHaveBeenLastCalledWith(
        'https://chat.example.test/c/conversation-2'
      )
    );
  });

  it('ignores another call result and clears the address when the current call changes', async () => {
    Object.defineProperty(document, 'referrer', {
      configurable: true,
      value: 'https://chat.example.test/c/conversation-1',
    });
    const onLinkedChatHrefChange = vi.fn();
    const { rerender } = renderHook(
      ({ callSessionId, conversationId, tasks }) =>
        useCallResultBridge({
          callSessionId,
          conversationId,
          tasks,
          onLinkedChatHrefChange,
        }),
      {
        initialProps: {
          callSessionId: 'call-1',
          conversationId: 'conversation-1' as string | null,
          tasks: [
            {
              ...resultTask(),
              callSessionId: 'other-call',
              conversationId: 'other-conversation',
            },
          ],
        },
      }
    );
    await waitFor(() =>
      expect(onLinkedChatHrefChange).toHaveBeenLastCalledWith(
        'https://chat.example.test/c/conversation-1'
      )
    );
    rerender({ callSessionId: 'call-2', conversationId: null, tasks: [] });
    await waitFor(() => expect(onLinkedChatHrefChange).toHaveBeenLastCalledWith(null));
  });

  it('waits for a canonical result when the call starts in a new chat', async () => {
    Object.defineProperty(document, 'referrer', {
      configurable: true,
      value: 'https://chat.example.test/new',
    });
    const onLinkedChatHrefChange = vi.fn();
    const { rerender } = renderHook(
      ({ tasks }) =>
        useCallResultBridge({
          callSessionId: 'call-1',
          conversationId: 'new',
          tasks,
          onLinkedChatHrefChange,
        }),
      { initialProps: { tasks: [] as VoiceTaskView[] } }
    );
    await waitFor(() => expect(onLinkedChatHrefChange).toHaveBeenLastCalledWith(null));
    rerender({ tasks: [resultTask()] });
    await waitFor(() =>
      expect(onLinkedChatHrefChange).toHaveBeenLastCalledWith(
        'https://chat.example.test/c/conversation-1'
      )
    );
  });

  it.each(['', '../unsafe'])(
    'does not expose a route without a valid current call ID: %s',
    async (callSessionId) => {
      Object.defineProperty(document, 'referrer', {
        configurable: true,
        value: 'https://chat.example.test/c/conversation-1',
      });
      const onLinkedChatHrefChange = vi.fn();
      renderHook(() =>
        useCallResultBridge({
          callSessionId,
          conversationId: 'conversation-1',
          tasks: [],
          onLinkedChatHrefChange,
        })
      );
      await waitFor(() => expect(onLinkedChatHrefChange).toHaveBeenLastCalledWith(null));
    }
  );
  it.each(['new', '../invalid'])(
    'retains the canonical address while a later task has no valid conversation: %s',
    async (conversationId) => {
      Object.defineProperty(document, 'referrer', {
        configurable: true,
        value: 'https://chat.example.test/c/conversation-1',
      });
      const onLinkedChatHrefChange = vi.fn();
      const { rerender } = renderHook(
        ({ tasks }) =>
          useCallResultBridge({
            callSessionId: 'call-1',
            conversationId: 'conversation-1',
            tasks,
            onLinkedChatHrefChange,
          }),
        {
          initialProps: {
            tasks: [{ ...resultTask(), conversationId: 'conversation-2' }],
          },
        }
      );
      await waitFor(() =>
        expect(onLinkedChatHrefChange).toHaveBeenLastCalledWith(
          'https://chat.example.test/c/conversation-2'
        )
      );
      rerender({
        tasks: [
          {
            ...resultTask(),
            type: 'state',
            state: 'running',
            phase: 'starting',
            conversationId,
          },
        ],
      });
      await waitFor(() =>
        expect(onLinkedChatHrefChange).toHaveBeenLastCalledWith(
          'https://chat.example.test/c/conversation-2'
        )
      );
    }
  );
});
