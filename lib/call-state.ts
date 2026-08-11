import type { VoiceCallMode } from '@/hooks/useCallSessionState';

export const VIVENTIUM_CALL_STATE_TOPIC = 'viventium.call.state.v1';

export const VOICE_CALL_STATUSES = [
  'created',
  'connecting',
  'listening',
  'speaking',
  'working',
  'needs_input',
  'degraded',
  'failed',
  'ended',
] as const;

export type VoiceCallStatus = (typeof VOICE_CALL_STATUSES)[number];

export type VoiceCallStateV1 = {
  version: 1;
  callSessionId: string;
  mode: VoiceCallMode;
  status: VoiceCallStatus;
  revision: number;
  updatedAt: string;
};

export function parseVoiceCallState(value: unknown): VoiceCallStateV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const state = value as Record<string, unknown>;
  if (
    state.version !== 1 ||
    typeof state.callSessionId !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,160}$/.test(state.callSessionId) ||
    (state.mode !== 'call' && state.mode !== 'wing' && state.mode !== 'listen_only') ||
    !VOICE_CALL_STATUSES.includes(state.status as VoiceCallStatus) ||
    typeof state.revision !== 'number' ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0 ||
    typeof state.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(state.updatedAt))
  ) {
    return null;
  }
  return {
    version: 1,
    callSessionId: state.callSessionId,
    mode: state.mode,
    status: state.status as VoiceCallStatus,
    revision: state.revision,
    updatedAt: state.updatedAt,
  };
}

export async function publishVoiceCallState(
  participant: {
    publishData: (payload: Uint8Array, options: { topic: string }) => Promise<unknown>;
  },
  state: VoiceCallStateV1
) {
  await participant.publishData(new TextEncoder().encode(JSON.stringify(state)), {
    topic: VIVENTIUM_CALL_STATE_TOPIC,
  });
}
