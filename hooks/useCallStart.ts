'use client';

/*
 * Starting a call (CP-CMP-004, CP-CMP-005, seam S5).
 *
 * Order, same as the live page: ask for the microphone, ask the server for the call, connect
 * with the microphone off, publish the microphone, start sound playback. Start, Retry, the
 * automatic start from the link and recovery after sleep all share one attempt at a time.
 *
 * Kept as it is today on purpose: upstream's `session.start()` would open the microphone and
 * the room in parallel and use the SDK's pre-connect audio buffer. Whether that is safe with
 * the voice worker's owner-admission window can only be judged in a real call.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ConnectionState, type LocalTrack, RoomEvent } from 'livekit-client';
import type { UseSessionReturn } from '@livekit/components-react';
import type { DeviceSoundMode } from '@/hooks/useDeviceSoundMode';
import { type CallIssue, CallRequestError, classifyCallIssue } from '@/lib/call-start';
import type { CallTokenSource } from '@/lib/call-token-source';
import { deviceSoundCaptureOptions, verifyDeviceSoundCapture } from '@/lib/device-sound-mode';
import {
  enableCallMicrophone,
  queryMicrophonePermissionState,
  readCallMicrophoneEnabled,
} from '@/lib/microphone-start';

/** How long the page waits for the assistant to join a signed call. */
export const CALL_AGENT_CONNECT_TIMEOUT_MS = 90_000;
const MICROPHONE_START_TIMEOUT_MS = 15_000;

export type UseCallStartOptions = {
  session: UseSessionReturn;
  tokens: CallTokenSource;
  callSessionId: string | null;
  /** The sound choice on this device; frozen for the call at its first Start. */
  soundMode: DeviceSoundMode;
  /** The call is over (ended here or reported ended by the server): never start it again. */
  ended: boolean;
  /** Latest issue from Core's existing call-state authority. Expiry cancels pending capture. */
  authorityIssue?: CallIssue | null;
  /** Start without a click, once, as soon as this is true. */
  autoStart: boolean;
};

export type UseCallStartResult = {
  /** Resolves `true` when the call is up. Concurrent callers share one attempt. */
  startCall: () => Promise<boolean>;
  /** Stops an attempt in progress (room lost, call ended elsewhere, assistant failed). */
  abortStart: () => void;
  isStarting: boolean;
  isMicrophoneStarting: boolean;
  startError: CallIssue | null;
  /** The sound mode this call is using; `null` before the first Start. */
  activeSoundMode: DeviceSoundMode | null;
};

export function useCallStart({
  session,
  tokens,
  callSessionId,
  soundMode,
  ended,
  authorityIssue,
  autoStart,
}: UseCallStartOptions): UseCallStartResult {
  const [isStarting, setIsStarting] = useState(autoStart && !ended);
  const [isMicrophoneStarting, setIsMicrophoneStarting] = useState(false);
  const [startError, setStartError] = useState<CallIssue | null>(null);
  const [activeSoundMode, setActiveSoundMode] = useState<DeviceSoundMode | null>(null);
  const activeSoundModeRef = useRef<DeviceSoundMode | null>(null);
  const startPromiseRef = useRef<Promise<boolean> | null>(null);
  const attemptRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  const autoStartedRef = useRef(false);

  const abortStart = useCallback(() => {
    attemptRef.current?.abort(
      new CallRequestError(
        {
          kind: 'gateway_down',
          message: 'The call disconnected before the microphone was ready. Please try again.',
        },
        true
      )
    );
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    session.room.on(RoomEvent.Disconnected, abortStart);
    return () => {
      mountedRef.current = false;
      session.room.off(RoomEvent.Disconnected, abortStart);
      // React Strict Mode replays cleanup and setup while the call stays mounted. Only a real
      // unmount cancels the microphone request.
      queueMicrotask(() => {
        if (!mountedRef.current) abortStart();
      });
    };
  }, [session.room, abortStart]);

  const authorityExpired = authorityIssue?.kind === 'auth_expired';
  const authorityMessage = authorityExpired ? authorityIssue.message : null;
  useEffect(() => {
    if (!ended && !authorityExpired) return;
    tokens.markEnding();
    attemptRef.current?.abort(
      new CallRequestError({
        kind: 'auth_expired',
        message: authorityMessage ?? 'This call has ended. Start a fresh call from Viventium.',
      })
    );
  }, [ended, authorityExpired, authorityMessage, tokens]);

  const startSession = useCallback(async () => {
    if (authorityExpired) {
      throw new CallRequestError({ kind: 'auth_expired', message: authorityMessage! });
    }
    if (ended || tokens.isEnding()) {
      throw new CallRequestError({
        kind: 'auth_expired',
        message: 'This call has ended. Start a fresh call from Viventium.',
      });
    }
    const retry = Boolean(attemptRef.current);
    const attempt = new AbortController();
    attemptRef.current = attempt;
    const room = session.room;
    let capturedTracks: LocalTrack[] = [];
    const stopCapturedTracks = async () => {
      capturedTracks.forEach((track) => track.stop());
      capturedTracks = [];
    };
    try {
      // The sound choice is frozen for this call, including reconnects and mute/unmute.
      const mode = activeSoundModeRef.current ?? soundMode;
      activeSoundModeRef.current = mode;
      setActiveSoundMode(mode);
      if (mode === 'earpiece') {
        room.options.audioCaptureDefaults = deviceSoundCaptureOptions(
          room.options.audioCaptureDefaults ?? {},
          mode
        );
      }

      // A call the user muted earlier starts muted without touching the microphone.
      const microphoneEnabled = readCallMicrophoneEnabled(callSessionId) !== false;
      if (microphoneEnabled) {
        setIsMicrophoneStarting(true);
        await enableCallMicrophone({
          permissionState: await queryMicrophonePermissionState(),
          signal: attempt.signal,
          enable: async () => {
            capturedTracks = await room.localParticipant.createTracks({
              audio: true,
              video: false,
            });
            verifyDeviceSoundCapture(mode, capturedTracks[0]);
          },
          disable: stopCapturedTracks,
          grantedTimeoutMs: MICROPHONE_START_TIMEOUT_MS,
        });
        setIsMicrophoneStarting(false);
      }

      attempt.signal.throwIfAborted();
      if (callSessionId) {
        await tokens.fetchForStart(retry);
      }
      attempt.signal.throwIfAborted();
      await session.start({
        signal: attempt.signal,
        tracks: { microphone: { enabled: false } },
      });

      if (microphoneEnabled) {
        setIsMicrophoneStarting(true);
        const disableMicrophone = () => {
          // A newer Retry may already own the microphone; never mute it from an old attempt.
          const current = attemptRef.current;
          if (current !== attempt && current && !current.signal.aborted) return Promise.resolve();
          return room.localParticipant.setMicrophoneEnabled(false);
        };
        try {
          await enableCallMicrophone({
            permissionState: 'granted',
            signal: attempt.signal,
            enable: async () => {
              await stopCapturedTracks();
              // The SDK owns publication, so mute, unmute and recovery cannot publish twice.
              const publication = await room.localParticipant.setMicrophoneEnabled(true);
              try {
                verifyDeviceSoundCapture(mode, publication?.track);
              } catch (error) {
                await disableMicrophone();
                throw error;
              }
            },
            disable: disableMicrophone,
            grantedTimeoutMs: MICROPHONE_START_TIMEOUT_MS,
          });
        } catch (error) {
          await session.end().catch(() => undefined);
          throw error;
        }
      }
      // If the browser refuses playback, the "Enable audio" notice appears by itself.
      await room.startAudio().catch(() => undefined);
    } catch (error) {
      attempt.abort(error);
      await stopCapturedTracks();
      throw error;
    } finally {
      setIsMicrophoneStarting(false);
    }
  }, [authorityExpired, authorityMessage, callSessionId, ended, session, soundMode, tokens]);

  const startCall = useCallback(() => {
    if (startPromiseRef.current) {
      return startPromiseRef.current;
    }
    setStartError(null);
    setIsStarting(true);
    const startPromise = (async () => {
      try {
        await startSession();
        return true;
      } catch (error) {
        console.error('[Viventium] Call start failed:', error);
        setStartError(classifyCallIssue(error));
        return false;
      } finally {
        startPromiseRef.current = null;
        setIsStarting(false);
      }
    })();
    startPromiseRef.current = startPromise;
    return startPromise;
  }, [startSession]);

  // Start from the link, once.
  useEffect(() => {
    if (autoStartedRef.current) return;
    if (!autoStart || ended || authorityExpired) {
      if (!startPromiseRef.current) setIsStarting(false);
      return;
    }
    autoStartedRef.current = true;
    if (session.isConnected || session.connectionState === ConnectionState.Connecting) {
      setIsStarting(false);
      return;
    }
    void startCall();
  }, [autoStart, authorityExpired, ended, session.connectionState, session.isConnected, startCall]);

  return { startCall, abortStart, isStarting, isMicrophoneStarting, startError, activeSoundMode };
}
