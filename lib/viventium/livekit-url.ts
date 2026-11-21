/*
 * Which LiveKit address the browser gets (CP-APP-014, server side only).
 *
 * A call can be opened from this Mac (local address), from a phone on the same network (LAN
 * address) or through the public tunnel (public address). The address handed out has to match
 * where the page was opened from, or the browser cannot reach LiveKit.
 *
 * One source of addresses per deployment:
 * - with `VIVENTIUM_PUBLIC_NETWORK_STATE_FILE`, the launcher-written file is the only source of
 *   LAN and public addresses (it is rewritten when the network changes, no restart needed);
 * - without it, the `VIVENTIUM_LAN_*` / `VIVENTIUM_PUBLIC_*` variables are.
 *
 * A request from a known LAN or public page origin whose address is not ready gets
 * `{ ready: false }` (a retryable error for the user), never a wrong address.
 */
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

type Env = Record<string, string | undefined>;

type Edge = { pageOrigin: string | null; livekitUrl: string | undefined };

export type LiveKitUrlResolution = { ready: true; url: string | undefined } | { ready: false };

function originOf(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function hostnameOf(origin: string): string | null {
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
}

/** The origin the page was opened from: `Origin`, else `Referer`, else the proxy's view. */
export function requestOrigin(req: Request): string | null {
  const fromHeaders =
    originOf(req.headers.get('origin')) ??
    originOf(req.headers.get('referer') ?? req.headers.get('referrer'));
  if (fromHeaders) {
    return fromHeaders;
  }
  const forwardedProto = (req.headers.get('x-forwarded-proto') || '').trim();
  const forwardedHost = (
    req.headers.get('x-forwarded-host') ||
    req.headers.get('host') ||
    ''
  ).trim();
  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }
  return originOf(req.url);
}

function isLiveLanAddress(address: unknown): boolean {
  return Object.values(networkInterfaces())
    .flat()
    .some((entry) => entry && !entry.internal && entry.address === address);
}

/** LAN and public edges from the launcher's state file; an unreadable file yields none. */
function edgesFromStateFile(stateFile: string): { lan: Edge; publicEdge: Edge } {
  const lan: Edge = { pageOrigin: null, livekitUrl: undefined };
  const publicEdge: Edge = { pageOrigin: null, livekitUrl: undefined };
  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
    const lanReady = state.lan_runtime_ready === true && isLiveLanAddress(state.lan_ip);
    if (!state.last_error && (!state.lan_ip || lanReady)) {
      publicEdge.pageOrigin = originOf(state.public_playground_url as string | undefined);
      publicEdge.livekitUrl = state.public_livekit_url as string | undefined;
    }
    if (lanReady) {
      lan.pageOrigin = originOf(state.lan_playground_url as string | undefined);
      lan.livekitUrl = state.lan_livekit_url as string | undefined;
    }
  } catch {
    // The launcher may be mid-write; the next request sees the recovered state.
  }
  return { lan, publicEdge };
}

export function resolveLiveKitUrl(
  origin: string | null,
  env: Env = process.env
): LiveKitUrlResolution {
  const stateFile = env.VIVENTIUM_PUBLIC_NETWORK_STATE_FILE;
  const configuredLanOrigin = originOf(env.VIVENTIUM_LAN_PLAYGROUND_URL);
  const configuredPublicOrigin = originOf(env.VIVENTIUM_PUBLIC_PLAYGROUND_URL);
  const { lan, publicEdge } = stateFile
    ? edgesFromStateFile(stateFile)
    : {
        lan: { pageOrigin: configuredLanOrigin, livekitUrl: env.VIVENTIUM_LAN_LIVEKIT_URL },
        publicEdge: {
          pageOrigin: configuredPublicOrigin,
          livekitUrl: env.VIVENTIUM_PUBLIC_LIVEKIT_URL,
        },
      };

  if (lan.pageOrigin && lan.livekitUrl && origin === lan.pageOrigin) {
    return { ready: true, url: lan.livekitUrl };
  }
  if (stateFile && origin) {
    const lanDomain = env.VIVENTIUM_LAN_DOMAIN;
    const isLanPage =
      origin === configuredLanOrigin ||
      Boolean(lanDomain && hostnameOf(origin) === `playground.${lanDomain}`);
    if (isLanPage) {
      return { ready: false };
    }
  }
  if (publicEdge.pageOrigin && publicEdge.livekitUrl && origin === publicEdge.pageOrigin) {
    return { ready: true, url: publicEdge.livekitUrl };
  }
  if (stateFile && origin && origin === configuredPublicOrigin) {
    return { ready: false };
  }
  return { ready: true, url: env.NEXT_PUBLIC_LIVEKIT_URL ?? env.LIVEKIT_URL };
}
