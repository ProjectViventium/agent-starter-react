import { describe, expect, it, vi } from 'vitest';
import {
  VIVENTIUM_CALL_STATE_TOPIC,
  parseVoiceCallState,
  publishVoiceCallState,
} from '@/lib/call-state';

const state = {
  version: 1 as const,
  callSessionId: 'call-1',
  mode: 'wing' as const,
  status: 'listening' as const,
  revision: 7,
  updatedAt: '2026-08-09T12:00:00.000Z',
};

describe('authoritative call mode state', () => {
  it('strictly accepts the server revision and rejects invented or malformed state', () => {
    expect(parseVoiceCallState(state)).toEqual(state);
    expect(parseVoiceCallState({ ...state, revision: -1 })).toBeNull();
    expect(parseVoiceCallState({ ...state, mode: 'shadow' })).toBeNull();
    expect(parseVoiceCallState({ ...state, status: 'provider_broken' })).toBeNull();
  });

  it('publishes the exact server event on the frozen LiveKit topic', async () => {
    const publishData = vi.fn().mockResolvedValue(undefined);
    await publishVoiceCallState({ publishData }, state);
    expect(publishData).toHaveBeenCalledWith(new TextEncoder().encode(JSON.stringify(state)), {
      topic: VIVENTIUM_CALL_STATE_TOPIC,
    });
  });
});
