import { describe, expect, it, vi } from 'vitest';
import { CALL_CAPABILITY_BOOTSTRAP_SCRIPT } from '@/lib/call-capability-bootstrap';

describe('pre-hydration call capability bootstrap', () => {
  it('stores and strips the fragment before any delayed app request', () => {
    const order: string[] = [];
    const capability = 'A'.repeat(43);
    const storage = new Map<string, string>();
    const fakeWindow = {
      location: {
        search: '?callSessionId=call-1&autoConnect=1',
        hash: `#viventiumCallCapability=${capability}`,
        pathname: '/call-bootstrap',
        replace: vi.fn(() => order.push('redirected')),
      },
      history: {
        state: null,
        replaceState: vi.fn(() => order.push('stripped')),
      },
      sessionStorage: {
        getItem: vi.fn((key: string) => storage.get(key) || null),
        setItem: vi.fn((key: string, value: string) => {
          order.push('stored');
          storage.set(key, value);
        }),
        removeItem: vi.fn((key: string) => storage.delete(key)),
      },
    };

    new Function('window', 'document', CALL_CAPABILITY_BOOTSTRAP_SCRIPT)(fakeWindow, {
      referrer: 'https://chat.example.test/c/conversation-1',
    });
    order.push('first-request');

    expect(order).toEqual(['stripped', 'stored', 'stored', 'redirected', 'first-request']);
    expect(fakeWindow.history.replaceState).toHaveBeenCalledWith(
      null,
      '',
      '/call-bootstrap?callSessionId=call-1&autoConnect=1'
    );
    expect(storage.get('viventium.call.capability.v1:call-1')).toBe(capability);
    expect(storage.get('viventium.call.opener-origin.v1:call-1')).toBe('https://chat.example.test');
    expect(fakeWindow.location.replace).toHaveBeenCalledWith(
      '/?callSessionId=call-1&autoConnect=1'
    );
    expect(CALL_CAPABILITY_BOOTSTRAP_SCRIPT).not.toContain(capability);
  });

  it('preserves a configured playground base path without accepting a redirect target', () => {
    const replace = vi.fn();
    const fakeWindow = {
      location: {
        search: '?callSessionId=call-2&autoConnect=1',
        hash: `#viventiumCallCapability=${'B'.repeat(43)}`,
        pathname: '/playground/call-bootstrap',
        replace,
      },
      history: { state: null, replaceState: vi.fn() },
      sessionStorage: { setItem: vi.fn() },
    };
    new Function('window', 'document', CALL_CAPABILITY_BOOTSTRAP_SCRIPT)(fakeWindow, {
      referrer: 'https://chat.example.test/c/2',
    });
    expect(replace).toHaveBeenCalledWith('/playground/?callSessionId=call-2&autoConnect=1');
  });

  it('strips a Telegram launch bearer before its first exchange and stores only the returned browser capability', async () => {
    const order: string[] = [];
    const launch = 'L'.repeat(43);
    const browserCapability = 'B'.repeat(43);
    const storage = new Map<string, string>();
    const fakeWindow = {
      location: {
        search: '?callSessionId=call-telegram&autoConnect=1',
        hash: `#viventiumCallLaunch=${launch}`,
        pathname: '/playground/call-bootstrap',
        replace: vi.fn(() => order.push('redirected')),
      },
      history: {
        state: null,
        replaceState: vi.fn(() => order.push('stripped')),
      },
      sessionStorage: {
        getItem: vi.fn((key: string) => storage.get(key) || null),
        setItem: vi.fn((key: string, value: string) => {
          order.push('stored');
          storage.set(key, value);
        }),
        removeItem: vi.fn((key: string) => storage.delete(key)),
      },
      fetch: vi.fn(async (url: string, init: RequestInit) => {
        order.push('exchange');
        expect(order[0]).toBe('stripped');
        expect(url).toBe('/playground/api/call-launch-exchange?callSessionId=call-telegram');
        expect(new Headers(init.headers).get('X-VIVENTIUM-CALL-LAUNCH')).toBe(launch);
        expect(url).not.toContain(launch);
        expect(init.body).toBeUndefined();
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              version: 1,
              callSessionId: 'call-telegram',
              browserCapability,
            }),
        };
      }),
      setTimeout,
      clearTimeout,
      AbortController,
      crypto: {
        getRandomValues: (bytes: Uint8Array) => {
          bytes.fill(7);
          return bytes;
        },
      },
      btoa: (value: string) => Buffer.from(value, 'binary').toString('base64'),
    };

    new Function('window', 'document', CALL_CAPABILITY_BOOTSTRAP_SCRIPT)(fakeWindow, {
      referrer: '',
    });
    await vi.waitFor(() => expect(fakeWindow.location.replace).toHaveBeenCalledTimes(1));

    expect(order).toEqual(['stripped', 'stored', 'exchange', 'stored', 'redirected']);
    expect(storage.get('viventium.call.capability.v1:call-telegram')).toBe(browserCapability);
    expect([...storage.values()]).not.toContain(launch);
    expect(storage.has('viventium.call.launch-idempotency.v1:call-telegram')).toBe(false);
    expect(fakeWindow.location.replace).toHaveBeenCalledWith(
      '/playground/?callSessionId=call-telegram&autoConnect=1'
    );
  });

  it('reuses the same browser binding when the consumed exchange response is lost', async () => {
    const launch = 'L'.repeat(43);
    const browserCapability = 'B'.repeat(43);
    const storage = new Map<string, string>();
    const idempotencyHeaders: string[] = [];
    let attempt = 0;
    const fakeWindow = {
      location: {
        search: '?callSessionId=call-lost-response',
        hash: `#viventiumCallLaunch=${launch}`,
        pathname: '/call-bootstrap',
        replace: vi.fn(),
      },
      history: { state: null, replaceState: vi.fn() },
      sessionStorage: {
        getItem: (key: string) => storage.get(key) || null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
      fetch: vi.fn(async (_url: string, init: RequestInit) => {
        idempotencyHeaders.push(
          new Headers(init.headers).get('X-VIVENTIUM-CALL-LAUNCH-IDEMPOTENCY') || ''
        );
        attempt += 1;
        if (attempt === 1) throw new TypeError('response lost after consume');
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              version: 1,
              callSessionId: 'call-lost-response',
              browserCapability,
            }),
        };
      }),
      setTimeout: (callback: () => void, delay: number) => {
        if (delay < 5_000) queueMicrotask(callback);
        return 1;
      },
      clearTimeout: vi.fn(),
      AbortController,
      crypto: {
        getRandomValues: (bytes: Uint8Array) => {
          bytes.fill(9);
          return bytes;
        },
      },
      btoa: (value: string) => Buffer.from(value, 'binary').toString('base64'),
    };

    new Function('window', 'document', CALL_CAPABILITY_BOOTSTRAP_SCRIPT)(fakeWindow, {
      referrer: '',
    });
    await vi.waitFor(() => expect(fakeWindow.location.replace).toHaveBeenCalledTimes(1));

    expect(fakeWindow.fetch).toHaveBeenCalledTimes(2);
    expect(idempotencyHeaders[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(idempotencyHeaders[1]).toBe(idempotencyHeaders[0]);
    expect(storage.get('viventium.call.capability.v1:call-lost-response')).toBe(browserCapability);
  });
});
