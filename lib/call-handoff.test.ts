import { describe, expect, it, vi } from 'vitest';
import {
  type CallResultBridgePayload,
  createCallResultBridge,
  resolveLinkedChatOrigin,
} from '@/lib/call-handoff';

describe('resolveLinkedChatOrigin', () => {
  it('uses the exact http(s) opener origin from the referrer', () => {
    expect(resolveLinkedChatOrigin('https://chat.example.com/c/123')).toBe(
      'https://chat.example.com'
    );
    expect(resolveLinkedChatOrigin('http://localhost:4190/c/123')).toBe('http://localhost:4190');
  });

  it('rejects hostile or non-origin referrers', () => {
    expect(resolveLinkedChatOrigin('javascript:alert(1)')).toBeNull();
    expect(resolveLinkedChatOrigin('data:text/html,hello')).toBeNull();
    expect(resolveLinkedChatOrigin('not a url')).toBeNull();
  });
});

describe('createCallResultBridge', () => {
  it('posts only to the exact trusted origin and deduplicates results', () => {
    const postMessage = vi.fn();
    const bridge = createCallResultBridge({
      opener: { postMessage },
      targetOrigin: 'https://chat.example.com',
    });
    const payload: CallResultBridgePayload = {
      version: 1,
      type: 'viventium.call.event.v1',
      event: 'result',
      callSessionId: 'call-1',
      conversationId: 'conversation-1',
      resultMessageId: 'message-1',
    };

    bridge.send(payload);
    bridge.send(payload);

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(payload, 'https://chat.example.com');
    expect(postMessage).not.toHaveBeenCalledWith(payload, '*');
  });

  it('does nothing without a validated target or opener', () => {
    const postMessage = vi.fn();
    createCallResultBridge({ opener: { postMessage }, targetOrigin: null }).send({
      version: 1,
      type: 'viventium.call.event.v1',
      event: 'ended',
      callSessionId: 'call-1',
      conversationId: 'conversation-1',
    });
    createCallResultBridge({ opener: null, targetOrigin: 'https://chat.example.com' }).send({
      version: 1,
      type: 'viventium.call.event.v1',
      event: 'ended',
      callSessionId: 'call-1',
      conversationId: 'conversation-1',
    });
    expect(postMessage).not.toHaveBeenCalled();
  });
});
