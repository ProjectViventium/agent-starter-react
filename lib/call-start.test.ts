import { describe, expect, it, vi } from 'vitest';
import {
  CALL_CAPABILITY_HEADER,
  callBrowserCapabilityHeaders,
  captureCallBrowserCapability,
  clearCallBrowserCapability,
  readCallBrowserCapability,
  readCallOpenerOrigin,
} from '@/lib/call-browser-capability';
import {
  CallRequestError,
  callIssueFromResponse,
  classifyCallIssue,
  readCallDeepLink,
} from '@/lib/call-start';

describe('readCallDeepLink', () => {
  it('keeps signed call-session autoConnect enabled', () => {
    const result = readCallDeepLink(
      '?callSessionId=call-1&conversationId=conversation-1&roomName=room-1&agentName=viventium&autoConnect=1'
    );
    expect(result.autoConnect).toBe(true);
    expect(result.expectedCallSessionId).toBe('call-1');
    expect(result.expectedConversationId).toBe('conversation-1');
    expect(result.tokenOptions?.roomName).toBe('room-1');
  });
});

describe('call browser capability', () => {
  it('captures a fragment capability, strips it synchronously, and restores it only by session', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    const replaceUrl = vi.fn();
    const capability = 'A'.repeat(43);

    expect(
      captureCallBrowserCapability({
        search: '?callSessionId=call-1&autoConnect=1',
        hash: `#viventiumCallCapability=${capability}`,
        pathname: '/',
        storage,
        replaceUrl,
      })
    ).toBe(true);
    expect(replaceUrl).toHaveBeenCalledWith('/?callSessionId=call-1&autoConnect=1');
    expect(callBrowserCapabilityHeaders('call-1')).toEqual({});
    expect(storage.getItem('viventium.call.capability.v1:call-1')).toBe(capability);
    expect(storage.getItem('viventium.call.capability.v1:call-2')).toBeNull();
    clearCallBrowserCapability('call-1', storage);
    expect(storage.getItem('viventium.call.capability.v1:call-1')).toBeNull();
    expect(CALL_CAPABILITY_HEADER).toBe('X-VIVENTIUM-CALL-CAPABILITY');
  });

  it('strips forged fragments but never stores them', () => {
    const setItem = vi.fn();
    const replaceUrl = vi.fn();
    expect(
      captureCallBrowserCapability({
        search: '?callSessionId=call-1',
        hash: '#viventiumCallCapability=short',
        pathname: '/call',
        storage: { setItem },
        replaceUrl,
      })
    ).toBe(false);
    expect(replaceUrl).toHaveBeenCalledWith('/call?callSessionId=call-1');
    expect(setItem).not.toHaveBeenCalled();
  });

  it('finishes fragment capture and stripping before bootstrap may issue a request', () => {
    const order: string[] = [];
    captureCallBrowserCapability({
      search: '?callSessionId=call-1',
      hash: `#viventiumCallCapability=${'A'.repeat(43)}`,
      pathname: '/',
      storage: { setItem: () => order.push('stored') },
      replaceUrl: () => order.push('stripped'),
    });
    order.push('request');
    expect(order).toEqual(['stripped', 'stored', 'request']);
  });
});

describe('callIssueFromResponse', () => {
  it('uses exact upstream codes and only status-based safe fallbacks', () => {
    expect(
      callIssueFromResponse(503, { code: 'provider_failure', message: 'Provider down' }).kind
    ).toBe('provider_failure');
    expect(callIssueFromResponse(410, { message: 'Gone' }).kind).toBe('auth_expired');
    expect(callIssueFromResponse(503, { message: 'Unavailable' }).kind).toBe('gateway_down');
    expect(callIssueFromResponse(400, { message: 'AssemblyAI provider words' }).kind).toBe(
      'unknown'
    );
  });
});

describe('classifyCallIssue', () => {
  it.each([
    [new DOMException('Permission denied', 'NotAllowedError'), 'mic_denied'],
    [new DOMException('No microphone', 'NotFoundError'), 'microphone_missing'],
    [{ code: 'auth_expired', message: 'Call expired' }, 'auth_expired'],
    [{ code: 'no_route', message: 'Voice not configured' }, 'no_route'],
    [{ code: 'gateway_down', message: 'Runtime unavailable' }, 'gateway_down'],
    [{ code: 'provider_failure', message: 'Configured provider unavailable' }, 'provider_failure'],
    [{ cause: new DOMException('Permission denied', 'NotAllowedError') }, 'mic_denied'],
  ] as const)('classifies %s as %s', (error, kind) => {
    expect(classifyCallIssue(error).kind).toBe(kind);
  });

  it('does not infer structured failures from provider or session words', () => {
    expect(classifyCallIssue(new Error('AssemblyAI provider unavailable')).kind).toBe('unknown');
    expect(classifyCallIssue(new Error('Call session expired')).kind).toBe('unknown');
  });

  it('preserves an authoritative retryable startup failure for the inline recovery action', () => {
    expect(
      classifyCallIssue(
        new CallRequestError(
          { kind: 'gateway_down', message: 'Microphone startup timed out.' },
          true
        )
      )
    ).toEqual({
      kind: 'gateway_down',
      message: 'Microphone startup timed out.',
      retryable: true,
    });
  });
});


describe('unavailable per-call browser storage', () => {
  const withBlockedStorage = (run: () => void) => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get: () => { throw new DOMException('Storage blocked', 'SecurityError'); },
    });
    try { run(); } finally {
      if (descriptor) Object.defineProperty(window, 'sessionStorage', descriptor);
    }
  };
  it('returns no capability when browser storage acquisition is denied', () => {
    withBlockedStorage(() => expect(readCallBrowserCapability('call-1')).toBeNull());
  });
  it('returns no opener when browser storage acquisition is denied', () => {
    withBlockedStorage(() => expect(readCallOpenerOrigin('call-1')).toBeNull());
  });
  it('lets call teardown finish when browser storage acquisition is denied', () => {
    withBlockedStorage(() => expect(() => clearCallBrowserCapability('call-1')).not.toThrow());
  });
  it('sends no capability header when browser storage acquisition is denied', () => {
    withBlockedStorage(() => expect(callBrowserCapabilityHeaders('call-1')).toEqual({}));
  });
  it('strips the fragment without granting authority when capture storage is blocked', () => {
    withBlockedStorage(() => {
      const replaceUrl = vi.fn();
      expect(captureCallBrowserCapability({ search: '?callSessionId=call-1',
        hash: `#viventiumCallCapability=${'A'.repeat(43)}`, pathname: '/', replaceUrl })).toBe(false);
      expect(replaceUrl).toHaveBeenCalledWith('/?callSessionId=call-1');
    });
  });
  it('returns no authority when storage reads fail', () => {
    const storage = { getItem: () => { throw new DOMException('Read denied', 'SecurityError'); } };
    expect(readCallBrowserCapability('call-1', storage)).toBeNull();
    expect(readCallOpenerOrigin('call-1', storage)).toBeNull();
  });
  it('lets teardown finish when removal fails', () => {
    const storage = { removeItem: () => { throw new DOMException('Removal denied', 'SecurityError'); } };
    expect(() => clearCallBrowserCapability('call-1', storage)).not.toThrow();
  });
  it('strips a fragment before refusing capture when storage writes fail', () => {
    const replaceUrl = vi.fn();
    expect(captureCallBrowserCapability({
      search: '?callSessionId=call-1', hash: `#viventiumCallCapability=${'A'.repeat(43)}`,
      pathname: '/', storage: { setItem: () => { throw new DOMException('Write denied', 'SecurityError'); } }, replaceUrl,
    })).toBe(false);
    expect(replaceUrl).toHaveBeenCalledWith('/?callSessionId=call-1');
  });
});
