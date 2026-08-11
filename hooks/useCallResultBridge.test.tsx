import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useCallResultBridge } from '@/hooks/useCallResultBridge';
import type { VoiceTaskView } from '@/lib/voice-events';

const originalReferrer = document.referrer;
const originalOpener = window.opener;

afterEach(() => {
  Object.defineProperty(document, 'referrer', { configurable: true, value: originalReferrer });
  Object.defineProperty(window, 'opener', { configurable: true, value: originalOpener });
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
      useCallResultBridge({ callSessionId: 'call-empty', conversationId: null, tasks: [] })
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
