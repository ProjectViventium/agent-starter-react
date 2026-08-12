import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useCallSessionVoiceSettings } from '@/hooks/useCallSessionVoiceSettings';
import type { VoiceRouteMetadata } from '@/hooks/useVoiceRoute';

const metadata: VoiceRouteMetadata = {
  stt: {
    provider: 'assemblyai',
    label: 'AssemblyAI',
    displayLabel: 'AssemblyAI',
    isLocal: false,
    variant: 'u3-rt-pro',
    variantLabel: 'u3-rt-pro',
    variantType: 'model',
  },
  tts: {
    provider: 'cartesia',
    label: 'Cartesia',
    displayLabel: 'Cartesia',
    isLocal: false,
    variant: 'voice-1',
    variantLabel: 'voice-1',
    variantType: 'voice',
  },
  ttsFallback: null,
  capabilities: [
    {
      id: 'assemblyai',
      modality: 'stt',
      label: 'AssemblyAI',
      isLocal: false,
      available: false,
      unavailableReason: 'Credential unavailable',
      variantLabel: 'Model',
      variants: [{ id: 'u3-rt-pro', label: 'U3' }],
    },
    {
      id: 'openai',
      modality: 'stt',
      label: 'OpenAI',
      isLocal: false,
      available: true,
      unavailableReason: null,
      variantLabel: 'Model',
      variants: [{ id: 'gpt-4o-transcribe', label: '4o' }],
    },
    {
      id: 'cartesia',
      modality: 'tts',
      label: 'Cartesia',
      isLocal: false,
      available: true,
      unavailableReason: null,
      variantLabel: 'Voice',
      variants: [{ id: 'voice-1', label: 'Voice 1' }],
    },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe('useCallSessionVoiceSettings immutable route preflight', () => {
  it('never silently remaps or persists an unavailable configured route', async () => {
    const requestedVoiceRoute = {
      stt: { provider: 'assemblyai', variant: 'u3-rt-pro' },
      tts: { provider: 'cartesia', variant: 'voice-1' },
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          requestedVoiceRoute,
          savedVoiceRoute: requestedVoiceRoute,
          selectionVoiceRoute: metadata,
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCallSessionVoiceSettings('call-1', metadata));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.configuredVoiceRoute).toEqual(requestedVoiceRoute);
    expect(result.current.issue?.kind).toBe('provider_failure');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('GET');
  });

  it('fails with no_route when either configured audio modality is missing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          requestedVoiceRoute: {
            stt: { provider: 'assemblyai', variant: 'u3-rt-pro' },
            tts: { provider: null, variant: null },
          },
          savedVoiceRoute: {
            stt: { provider: null, variant: null },
            tts: { provider: null, variant: null },
          },
          selectionVoiceRoute: metadata,
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCallSessionVoiceSettings('call-1', metadata));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.issue?.kind).toBe('no_route');
  });
});
