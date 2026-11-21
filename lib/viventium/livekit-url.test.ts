import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { requestOrigin, resolveLiveKitUrl } from '@/lib/viventium/livekit-url';

const LOCAL = 'ws://localhost:7888';
const env = {
  LIVEKIT_URL: LOCAL,
  VIVENTIUM_PUBLIC_PLAYGROUND_URL: 'https://voice.example.test',
  VIVENTIUM_PUBLIC_LIVEKIT_URL: 'wss://signal.example.test',
  VIVENTIUM_LAN_PLAYGROUND_URL: 'https://192.168.1.20:8443',
  VIVENTIUM_LAN_LIVEKIT_URL: 'wss://192.168.1.20:8444',
};

describe('requestOrigin', () => {
  const request = (headers: Record<string, string>) =>
    new Request('http://internal.example.test:3300/api/token', { method: 'POST', headers });

  it('prefers Origin, then Referer, then the forwarding proxy, then the request URL', () => {
    expect(
      requestOrigin(
        request({ Origin: 'https://a.example.test', Referer: 'https://b.example.test/x' })
      )
    ).toBe('https://a.example.test');
    expect(requestOrigin(request({ Referer: 'https://b.example.test/x?y=1' }))).toBe(
      'https://b.example.test'
    );
    expect(
      requestOrigin(request({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'c.example.test' }))
    ).toBe('https://c.example.test');
    expect(requestOrigin(request({}))).toBe('http://internal.example.test:3300');
  });
});

describe('resolveLiveKitUrl from environment addresses', () => {
  it.each([
    ['https://192.168.1.20:8443', 'wss://192.168.1.20:8444'],
    ['https://voice.example.test', 'wss://signal.example.test'],
    ['http://localhost:3300', LOCAL],
    [null, LOCAL],
  ])('maps page origin %s to %s', (origin, url) => {
    expect(resolveLiveKitUrl(origin, env)).toEqual({ ready: true, url });
  });

  it('prefers the browser-facing local address over the server-side one', () => {
    expect(
      resolveLiveKitUrl('http://localhost:3300', {
        LIVEKIT_URL: 'ws://livekit:7880',
        NEXT_PUBLIC_LIVEKIT_URL: LOCAL,
      })
    ).toEqual({ ready: true, url: LOCAL });
  });
});

describe('resolveLiveKitUrl from the launcher state file', () => {
  const directories: string[] = [];
  const stateFile = (state: Record<string, unknown>) => {
    const directory = mkdtempSync(join(tmpdir(), 'viv-livekit-url-'));
    directories.push(directory);
    const file = join(directory, 'network.json');
    writeFileSync(file, JSON.stringify(state));
    return file;
  };
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  const liveLanIp = Object.values(networkInterfaces())
    .flat()
    .find((address) => address && !address.internal)?.address;
  const publicState = {
    public_playground_url: 'https://voice.example.test',
    public_livekit_url: 'wss://signal-current.example.test',
  };

  it('takes the public address only from the file and never from startup variables', () => {
    const file = stateFile(publicState);
    expect(
      resolveLiveKitUrl('https://voice.example.test', {
        ...env,
        VIVENTIUM_PUBLIC_NETWORK_STATE_FILE: file,
      })
    ).toEqual({ ready: true, url: 'wss://signal-current.example.test' });
  });

  it.each([
    ['a reported error', { ...publicState, last_error: 'tunnel down' }],
    ['a LAN address that is not ready', { ...publicState, lan_ip: '203.0.113.9' }],
  ])('refuses the public page while the file has %s', (_label, state) => {
    expect(
      resolveLiveKitUrl('https://voice.example.test', {
        ...env,
        VIVENTIUM_PUBLIC_NETWORK_STATE_FILE: stateFile(state),
      })
    ).toEqual({ ready: false });
  });

  it('refuses a known remote page when the file is unreadable, and keeps local calls working', () => {
    const missing = join(tmpdir(), 'viv-livekit-url-missing', 'network.json');
    const withFile = {
      ...env,
      VIVENTIUM_PUBLIC_NETWORK_STATE_FILE: missing,
      VIVENTIUM_LAN_DOMAIN: 'lan.example.test',
    };
    expect(resolveLiveKitUrl('https://voice.example.test', withFile)).toEqual({ ready: false });
    expect(resolveLiveKitUrl('https://192.168.1.20:8443', withFile)).toEqual({ ready: false });
    expect(resolveLiveKitUrl('https://playground.lan.example.test:9443', withFile)).toEqual({
      ready: false,
    });
    expect(resolveLiveKitUrl('http://localhost:3300', withFile)).toEqual({
      ready: true,
      url: LOCAL,
    });
  });

  it('hands out the LAN address only while its interface is live and ready', () => {
    expect(liveLanIp).toBeTruthy();
    const lanState = (ready: boolean) => ({
      lan_ip: liveLanIp,
      lan_runtime_ready: ready,
      lan_playground_url: 'https://playground.lan.example.test:9443',
      lan_livekit_url: 'wss://livekit.lan.example.test:9444',
    });
    const resolve = (ready: boolean) =>
      resolveLiveKitUrl('https://playground.lan.example.test:9443', {
        ...env,
        VIVENTIUM_LAN_DOMAIN: 'lan.example.test',
        VIVENTIUM_PUBLIC_NETWORK_STATE_FILE: stateFile(lanState(ready)),
      });
    expect(resolve(true)).toEqual({ ready: true, url: 'wss://livekit.lan.example.test:9444' });
    expect(resolve(false)).toEqual({ ready: false });
  });
});
