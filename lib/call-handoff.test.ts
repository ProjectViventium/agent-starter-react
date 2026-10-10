import { describe, expect, it, vi } from 'vitest';
import {
  type CallResultBridgePayload,
  createCallResultBridge,
  resolveLinkedChatHref,
  resolveLinkedChatOrigin,
  retainedLinkedChatHref,
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
    createCallResultBridge({
      opener: { postMessage },
      targetOrigin: null,
    }).send({
      version: 1,
      type: 'viventium.call.event.v1',
      event: 'ended',
      callSessionId: 'call-1',
      conversationId: 'conversation-1',
    });
    createCallResultBridge({
      opener: null,
      targetOrigin: 'https://chat.example.com',
    }).send({
      version: 1,
      type: 'viventium.call.event.v1',
      event: 'ended',
      callSessionId: 'call-1',
      conversationId: 'conversation-1',
    });
    expect(postMessage).not.toHaveBeenCalled();
  });
});

describe('linked chat address', () => {
  it('builds only a normal chat route from the verified origin and current conversation', () => {
    expect(resolveLinkedChatHref('https://chat.example.test', 'conversation-2')).toBe(
      'https://chat.example.test/c/conversation-2'
    );
  });
  it.each([
    [null, 'conversation-1'],
    ['javascript:alert(1)', 'conversation-1'],
    ['https://chat.example.test/path', 'conversation-1'],
    ['https://secret@chat.example.test', 'conversation-1'],
    ['https://chat.example.test', 'new'],
    ['https://chat.example.test', '../other'],
    ['https://chat.example.test', 'conversation-1?owner=other'],
    ['https://chat.example.test', 'x'.repeat(161)],
  ])('does not manufacture a chat target from an invalid origin or ID: %s', (origin, id) => {
    expect(resolveLinkedChatHref(origin, id)).toBeNull();
  });
});

describe('normal chat navigation across ended reloads', () => {
  it('keeps only the current call route and no call capability', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const href = 'https://chat.example.test/c/conversation-final';
    expect(retainedLinkedChatHref('call-1', href, storage)).toBe(href);
    expect(retainedLinkedChatHref('call-1', undefined, storage)).toBe(href);
    expect(retainedLinkedChatHref('call-2', undefined, storage)).toBeNull();
    expect([...values.keys()]).toEqual(['viventium.call.linked-chat.v1:call-1']);
    expect([...values.values()]).toEqual([href]);
  });
  it.each([
    'javascript:alert(1)',
    'https://secret@chat.example.test/c/conversation-1',
    'https://chat.example.test/c/new',
    'https://chat.example.test/c/id?token=secret',
    'https://chat.example.test/c/id#secret',
    'https://chat.example.test/c/id/other',
  ])('ignores malformed stored or supplied navigation %s', (href) => {
    const setItem = vi.fn();
    const storage = { getItem: () => href, setItem };
    expect(retainedLinkedChatHref('call-1', undefined, storage)).toBeNull();
    expect(retainedLinkedChatHref('call-1', href, storage)).toBeNull();
    expect(setItem).not.toHaveBeenCalled();
  });
  it('does not break the call when tab storage is unavailable', () => {
    const storage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: vi.fn(),
    };
    expect(retainedLinkedChatHref('call-1', undefined, storage)).toBeNull();
    expect(
      retainedLinkedChatHref('../other', 'https://chat.example.test/c/id', storage)
    ).toBeNull();
  });
});

describe('blocked browser storage acquisition', () => {
  it.each([undefined, 'https://chat.example.test/c/id'])(
    'does not break navigation when the browser denies sessionStorage: %s',
    (href) => {
      const descriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
      Object.defineProperty(window, 'sessionStorage', {
        configurable: true,
        get: () => {
          throw new DOMException('Storage blocked', 'SecurityError');
        },
      });
      try {
        expect(retainedLinkedChatHref('call-1', href)).toBeNull();
      } finally {
        if (descriptor) Object.defineProperty(window, 'sessionStorage', descriptor);
      }
    }
  );
});
