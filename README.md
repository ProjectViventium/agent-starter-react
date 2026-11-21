# Viventium call page

The Viventium voice interface is based on [LiveKit agent-starter-react](https://github.com/livekit-examples/agent-starter-react) and [Agents UI](https://livekit.io/ui). It retains Call, Wing and Listen-Only modes, worker questions, task and file results, speaker captions, and speech-provider choices. The owning Viventium requirements and QA define product behavior.

## Local setup

Use Node.js 24 and the pnpm version declared in `package.json`.

```bash
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm dev
```

Fill the required LiveKit settings and both `VIVENTIUM_LIBRECHAT_ORIGIN` and `VIVENTIUM_CALL_SESSION_SECRET`. The Viventium launcher supplies these values in an installed stack. Keep filled configuration and credentials outside Git. Open a signed call from Viventium; opening the page alone does not grant call access.

For an isolated unsigned development room, explicitly set `VIVENTIUM_ALLOW_DIRECT_AGENT_DISPATCH=1`. This mode creates a fresh random room and ignores caller-selected rooms and agent metadata. It does not dispatch a voice worker. Set `AGENT_NAME` to expose the development Start control, and arrange a development worker separately. The upstream development token server and `LIVEKIT_TOKEN_SERVER_ID` are not used by this fork.

## Call and backend boundaries

- `GET /call-bootstrap?callSessionId=…#viventiumCallCapability=…` moves the per-call capability out of the address before redirecting to the call page. One-time links use `#viventiumCallLaunch=…`.
- `POST /api/token` requires the call's capability header and canonical Core record. Room, identity, agent and dispatch metadata come from Core. `/api/connection-details` keeps the previous POST URL as an adapter to the same checks.
- `app/api/call-tasks/proxy.ts` owns Core paths, server credentials and bounded requests. The browser calls only same-origin routes.
- The microphone, token and connection start share one attempt. The session mounts only after Start or an explicit auto-connect link passes Core's existing call-state authority check. SDK prewarm waits for microphone capture before the token request can dispatch a worker.
- `.env.example` lists server settings. `lib/viventium/config.ts` owns page branding; `styles/globals.css` owns colors. `GET /api/health` reports the compiled source identity.
- Provider catalogs come from the voice gateway. A running worker keeps the voice route it started with; later changes are saved for the next start. No fallback catalog invents provider availability.

## Validation

```bash
pnpm test
pnpm exec tsc --noEmit
pnpm build
```

These checks do not prove audible audio or phone routing. Real calls require a configured Core, LiveKit, voice gateway, and device permissions. Use isolated synthetic configuration for local QA; do not connect test runs to owner data.

## UI sources

`components/agents-ui` contains the reusable LiveKit components. `components/app` and `hooks/useCall*` contain Viventium's call behavior. `lib/call-token-source.ts` carries signed-call capabilities through the SDK token lifecycle. Provider logo attribution is in `public/providers/SOURCE.md`. The optional aura visualizer uses an independently written native SVG under the repository MIT license. The upstream non-resale aura shader is not included. Copied Agents UI sources retain their Apache-2.0 license and notice; the wave shader helper retains its complete MIT header. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The call transcript uses `TranscriptText`, which renders authored markup as escaped text and allows
only supported links. The unused upstream session block and its Streamdown renderer are excluded:
messages must not turn remote images, frames or scripts into live page elements. Task and result-file
failure tests also guard against writing private inputs, identities or raw errors to the console.

The refresh replaces the old page layout and token-source implementation. Compatibility routes, bootstrap links, task contracts, the end-call path, and the manual phone diagnostic remain available.

## Viventium clarification delivery

The voice interface presents questions owned by the existing worker harness. It is a courier,
not a second agent manager. Native question forms preserve exact question keys, selected values,
free-text notes, and the request fingerprint. A new request clears old selections; a refreshed
snapshot of the same request keeps them. Native permission requests keep the action details
available without reading internal status text as a conversational reply.

Do not replace this contract with prompt keywords, generic status messages, automatic approvals,
or a separate voice-only orchestration framework. Text, Telegram, and voice use the same worker
request ownership. The focused cases in `lib/voice-events.test.ts` and
`components/app/call-activity.test.tsx` retain the parser and presentation boundaries. Passing
these cases alone does not prove always-on voice reliability or a response latency target.

## Viventium call startup and device sound

The Voice menu offers a browser-local sound preference before a call starts. Speaker keeps normal
echo processing. Earpiece / headphones requests echo processing off and requires the browser to
confirm the effective capture setting. This preference does not guarantee a physical output route.
The first Start captures the choice for that call; changing the preference applies to the next call
and does not replace an active microphone or interrupt speech.

For managed calls, Core's signed call-state check finishes before SDK preparation or microphone access. The explicit Start still finishes microphone permission and capture before dispatch; eager SDK prewarm waits for that same prepared token. The LiveKit SDK owns
microphone publication after connection. Leaving, denial, expiry, or an authoritative ended state cancels
pending capture; a late permission result is disposed without dispatch and a failed initial state check can be retried. Recovery shares the existing in-flight Start rather than publishing another track.

When configured, `VIVENTIUM_PUBLIC_NETWORK_STATE_FILE` is read for each connection request. A LAN
route is accepted only when its published readiness and address match a current network interface.
Stale or unreadable managed state fails explicitly instead of reusing startup addresses. Existing
public and loopback route selection remains separate.

`/phone-sound-check.html` is a manual browser diagnostic. It plays a quiet tone, requests microphone
access only after an explicit test action, and records or uploads nothing. A clear tone does not
establish clear speech, speaker routing, or two-way call quality. Generated Next build caches and
machine-specific type-generation paths must stay outside versioned source configuration.

The device-sound, call-start, call-token-source, token-authority, voice-picker, and control-bar tests cover
these boundaries with synthetic data. Real phone audio still requires the audible device path.
