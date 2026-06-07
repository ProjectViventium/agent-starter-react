'use client';

import { useMemo } from 'react';
import { useRemoteParticipants } from '@livekit/components-react';
import type { AppConfig } from '@/app-config';

export type VoiceRouteSelection = {
  provider: string | null;
  variant: string | null;
};

export type VoiceRouteState = {
  stt: VoiceRouteSelection;
  tts: VoiceRouteSelection;
};

export type VoiceRouteCapabilityVariant = {
  id: string;
  label: string;
};

export type VoiceRouteCapability = {
  id: string;
  modality: 'stt' | 'tts';
  label: string;
  isLocal: boolean;
  available: boolean;
  unavailableReason: string | null;
  variantLabel: string;
  variants: VoiceRouteCapabilityVariant[];
};

export type VoiceRouteInfo = {
  provider: string | null;
  label: string;
  displayLabel: string;
  isLocal: boolean;
  variant: string | null;
  variantLabel: string | null;
  variantType: string | null;
};

export type VoiceRouteMetadata = {
  stt: VoiceRouteInfo;
  tts: VoiceRouteInfo;
  ttsFallback: VoiceRouteInfo | null;
  capabilities: VoiceRouteCapability[];
};

export type VoiceRouteAutoCorrection = {
  changed: boolean;
  message: string | null;
  requestedVoiceRoute: VoiceRouteState;
};

const CARTESIA_MEGAN_VOICE_ID = 'e8e5fffb-252c-436d-b842-8879b84445b6';
const CARTESIA_LYRA_VOICE_ID = '6ccbfb76-1fc6-48f7-b71d-91ac6298247b';
const CARTESIA_VOICE_VARIANTS: VoiceRouteCapabilityVariant[] = [
  { id: CARTESIA_MEGAN_VOICE_ID, label: 'Megan' },
  { id: CARTESIA_LYRA_VOICE_ID, label: 'Lyra' },
];

export function createEmptyVoiceRouteSelection(): VoiceRouteSelection {
  return {
    provider: null,
    variant: null,
  };
}

export function createEmptyVoiceRouteState(): VoiceRouteState {
  return {
    stt: createEmptyVoiceRouteSelection(),
    tts: createEmptyVoiceRouteSelection(),
  };
}

export function normalizeProviderName(value?: string | null) {
  const normalized = (value ?? '').trim().toLowerCase();
  switch (normalized) {
    case 'whisper_local':
      return 'pywhispercpp';
    case 'x_ai':
    case 'xai_grok_voice':
      return 'xai';
    default:
      return normalized;
  }
}

function normalizeText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function formatProviderName(value?: string | null) {
  const normalized = normalizeProviderName(value);
  switch (normalized) {
    case 'whisper_local':
    case 'pywhispercpp':
      return 'Whisper.cpp Local';
    case 'openai':
      return 'OpenAI';
    case 'xai':
    case 'x_ai':
    case 'xai_grok_voice':
      return 'xAI';
    case 'elevenlabs':
      return 'ElevenLabs';
    case 'cartesia':
      return 'Cartesia';
    case 'local_chatterbox_turbo_mlx_8bit':
      return 'Local Chatterbox';
    case 'assemblyai':
      return 'AssemblyAI';
    default:
      if (!normalized) {
        return 'Not configured';
      }
      return normalized
        .split(/[_\s-]+/)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
  }
}

function isLocalProvider(provider: string | null | undefined) {
  const normalized = normalizeProviderName(provider);
  return (
    normalized === 'pywhispercpp' ||
    normalized === 'whisper_local' ||
    normalized === 'local_chatterbox_turbo_mlx_8bit'
  );
}

function buildDisplayLabel(label: string, variant: string | null) {
  return variant ? `${label} • ${variant}` : label;
}

function buildLocalWhisperVariantLabel(modelId: string, recommendedModel: string) {
  const labels: Record<string, string> = {
    'tiny.en': 'Fastest',
    'base.en': 'Light',
    small: 'Balanced',
    'small.en': 'Balanced',
    medium: 'More accurate',
    'medium.en': 'More accurate',
    'large-v3': 'Highest accuracy',
    'large-v3-q5_0': 'Highest accuracy quantized',
    'large-v3-turbo': 'Best quality',
    'large-v3-turbo-q5_0': 'Best quality quantized',
  };
  const descriptor = labels[modelId];
  const baseLabel = descriptor ? `${descriptor} - ${modelId}` : modelId;
  return modelId === recommendedModel ? `${baseLabel} (Recommended)` : baseLabel;
}

function getRecommendedLocalWhisperModel(appConfig: AppConfig) {
  return appConfig.voiceSttModel || 'large-v3-turbo';
}

function normalizeSelection(value: unknown): VoiceRouteSelection {
  if (!value || typeof value !== 'object') {
    return createEmptyVoiceRouteSelection();
  }
  const selection = value as Partial<VoiceRouteSelection>;
  return {
    provider: normalizeText(selection.provider),
    variant: normalizeText(selection.variant),
  };
}

export function normalizeVoiceRouteState(value: unknown): VoiceRouteState {
  if (!value || typeof value !== 'object') {
    return createEmptyVoiceRouteState();
  }
  const route = value as Partial<VoiceRouteState>;
  return {
    stt: normalizeSelection(route.stt),
    tts: normalizeSelection(route.tts),
  };
}

function normalizeRouteInfo(value: unknown, fallback?: Partial<VoiceRouteInfo>): VoiceRouteInfo {
  if (!value || typeof value !== 'object') {
    const label = fallback?.label ?? formatProviderName(fallback?.provider);
    const variant = fallback?.variant ?? null;
    return {
      provider: fallback?.provider ?? null,
      label,
      displayLabel: buildDisplayLabel(label, variant),
      isLocal: fallback?.isLocal ?? isLocalProvider(fallback?.provider),
      variant,
      variantLabel: variant,
      variantType: fallback?.variantType ?? null,
    };
  }

  const info = value as Partial<VoiceRouteInfo>;
  const provider = normalizeText(info.provider) ?? fallback?.provider ?? null;
  const label = normalizeText(info.label) ?? fallback?.label ?? formatProviderName(provider);
  const variant = normalizeText(info.variant) ?? fallback?.variant ?? null;
  const variantLabel = normalizeText(info.variantLabel) ?? variant;
  return {
    provider,
    label,
    displayLabel: normalizeText(info.displayLabel) ?? buildDisplayLabel(label, variant),
    isLocal:
      typeof info.isLocal === 'boolean'
        ? info.isLocal
        : (fallback?.isLocal ?? isLocalProvider(provider)),
    variant,
    variantLabel,
    variantType: normalizeText(info.variantType) ?? fallback?.variantType ?? null,
  };
}

function normalizeCapabilities(
  value: unknown,
  fallback: VoiceRouteCapability[]
): VoiceRouteCapability[] {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const normalized = value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }
      const capability = entry as Partial<VoiceRouteCapability>;
      const modality =
        capability.modality === 'stt' || capability.modality === 'tts' ? capability.modality : null;
      const id = normalizeText(capability.id);
      if (!modality || !id) {
        return null;
      }
      return {
        id,
        modality,
        label: normalizeText(capability.label) ?? formatProviderName(id),
        isLocal: typeof capability.isLocal === 'boolean' ? capability.isLocal : isLocalProvider(id),
        available: capability.available !== false,
        unavailableReason: normalizeText(capability.unavailableReason),
        variantLabel: normalizeText(capability.variantLabel) ?? 'Model',
        variants: Array.isArray(capability.variants)
          ? capability.variants
              .map((variant) => {
                if (!variant || typeof variant !== 'object') {
                  return null;
                }
                const next = variant as Partial<VoiceRouteCapabilityVariant>;
                const id = normalizeText(next.id);
                if (!id) {
                  return null;
                }
                return {
                  id,
                  label: normalizeText(next.label) ?? id,
                };
              })
              .filter((variant): variant is VoiceRouteCapabilityVariant => Boolean(variant))
          : [],
      };
    })
    .filter((entry): entry is VoiceRouteCapability => Boolean(entry));

  return normalized.length > 0 ? normalized : fallback;
}

function buildFallbackCapabilities(appConfig: AppConfig): VoiceRouteCapability[] {
  const recommendedLocalWhisperModel = getRecommendedLocalWhisperModel(appConfig);
  return [
    {
      id: 'openai',
      modality: 'stt',
      label: 'OpenAI',
      isLocal: false,
      available: true,
      unavailableReason: null,
      variantLabel: 'Model',
      variants: [
        { id: 'gpt-4o-mini-transcribe', label: 'gpt-4o-mini-transcribe' },
        { id: 'gpt-4o-transcribe', label: 'gpt-4o-transcribe' },
        { id: 'whisper-1', label: 'whisper-1' },
      ].filter(
        (variant, index, all) => all.findIndex((candidate) => candidate.id === variant.id) === index
      ),
    },
    {
      id: 'assemblyai',
      modality: 'stt',
      label: 'AssemblyAI',
      isLocal: false,
      available: true,
      unavailableReason: null,
      variantLabel: 'Engine',
      // Mirrors the voice-gateway AssemblyAI capability catalog (worker.py ASSEMBLYAI_STT_MODELS).
      // Used only until the live agent publishes its real capabilities; ids must stay aligned with
      // the livekit-plugins-assemblyai model set. Default/first entry is the proven u3-rt-pro.
      variants: [
        { id: 'u3-rt-pro', label: 'Universal-3 Pro streaming (u3-rt-pro)' },
        { id: 'universal-streaming-english', label: 'Universal Streaming (English)' },
        { id: 'universal-streaming-multilingual', label: 'Universal Streaming (Multilingual)' },
      ],
    },
    {
      id: 'pywhispercpp',
      modality: 'stt',
      label: 'Whisper.cpp Local',
      isLocal: true,
      available: true,
      unavailableReason: null,
      variantLabel: 'Model',
      variants: [
        {
          id: recommendedLocalWhisperModel,
          label: buildLocalWhisperVariantLabel(
            recommendedLocalWhisperModel,
            recommendedLocalWhisperModel
          ),
        },
        {
          id: 'tiny.en',
          label: buildLocalWhisperVariantLabel('tiny.en', recommendedLocalWhisperModel),
        },
        {
          id: 'base.en',
          label: buildLocalWhisperVariantLabel('base.en', recommendedLocalWhisperModel),
        },
        {
          id: 'small.en',
          label: buildLocalWhisperVariantLabel('small.en', recommendedLocalWhisperModel),
        },
        {
          id: 'medium',
          label: buildLocalWhisperVariantLabel('medium', recommendedLocalWhisperModel),
        },
        {
          id: 'large-v3-turbo',
          label: buildLocalWhisperVariantLabel('large-v3-turbo', recommendedLocalWhisperModel),
        },
      ].filter(
        (variant, index, all) => all.findIndex((candidate) => candidate.id === variant.id) === index
      ),
    },
    {
      id: 'openai',
      modality: 'tts',
      label: 'OpenAI',
      isLocal: false,
      available: true,
      unavailableReason: null,
      variantLabel: 'Model',
      variants: [
        {
          id: appConfig.openaiTtsModel || 'gpt-4o-mini-tts',
          label: appConfig.openaiTtsModel || 'gpt-4o-mini-tts',
        },
      ],
    },
    {
      id: 'elevenlabs',
      modality: 'tts',
      label: 'ElevenLabs',
      isLocal: false,
      available: true,
      unavailableReason: null,
      variantLabel: 'Voice',
      variants: [{ id: 'default', label: 'default' }],
    },
    {
      id: 'cartesia',
      modality: 'tts',
      label: 'Cartesia',
      isLocal: false,
      available: true,
      unavailableReason: null,
      variantLabel: 'Voice',
      variants: CARTESIA_VOICE_VARIANTS,
    },
    {
      id: 'xai',
      modality: 'tts',
      label: 'xAI',
      isLocal: false,
      available: true,
      unavailableReason: null,
      variantLabel: 'Voice',
      variants: ['Ara', 'Eve', 'Leo', 'Rex', 'Sal'].map((voice) => ({ id: voice, label: voice })),
    },
    {
      id: 'local_chatterbox_turbo_mlx_8bit',
      modality: 'tts',
      label: 'Local Chatterbox',
      isLocal: true,
      available: true,
      unavailableReason: null,
      variantLabel: 'Model',
      variants: [
        { id: 'mlx-community/chatterbox-turbo-8bit', label: 'mlx-community/chatterbox-turbo-8bit' },
      ],
    },
  ];
}

export function buildFallbackVoiceRoute(appConfig: AppConfig): VoiceRouteMetadata {
  const sttProvider = normalizeProviderName(appConfig.voiceSttProvider) || 'pywhispercpp';
  const recommendedLocalWhisperModel = getRecommendedLocalWhisperModel(appConfig);
  const ttsProvider = normalizeProviderName(appConfig.voiceTtsProvider) || 'openai';
  const ttsVariant =
    ttsProvider === 'openai'
      ? appConfig.openaiTtsModel || 'gpt-4o-mini-tts'
      : ttsProvider === 'cartesia'
        ? CARTESIA_MEGAN_VOICE_ID
        : null;
  const fallbackProvider = normalizeProviderName(appConfig.voiceTtsFallbackProvider) || null;
  const capabilities = buildFallbackCapabilities(appConfig);

  return {
    stt: normalizeRouteInfo(null, {
      provider: sttProvider,
      label: formatProviderName(sttProvider),
      variant:
        sttProvider === 'openai'
          ? 'gpt-4o-mini-transcribe'
          : sttProvider === 'pywhispercpp'
            ? recommendedLocalWhisperModel
            : null,
      variantType: sttProvider === 'assemblyai' ? 'Engine' : 'Model',
    }),
    tts: normalizeRouteInfo(null, {
      provider: ttsProvider,
      label: formatProviderName(ttsProvider),
      variant: ttsVariant,
      variantType: ttsProvider === 'xai' || ttsProvider === 'elevenlabs' ? 'Voice' : 'Model',
    }),
    ttsFallback: fallbackProvider
      ? normalizeRouteInfo(null, {
          provider: fallbackProvider,
          label: formatProviderName(fallbackProvider),
          variant:
            fallbackProvider === 'openai' ? appConfig.openaiTtsModel || 'gpt-4o-mini-tts' : null,
          variantType:
            fallbackProvider === 'xai' || fallbackProvider === 'elevenlabs' ? 'Voice' : 'Model',
        })
      : null,
    capabilities,
  };
}

export function normalizeVoiceRouteMetadata(
  value: unknown,
  fallbackRoute: VoiceRouteMetadata
): VoiceRouteMetadata {
  if (!value || typeof value !== 'object') {
    return fallbackRoute;
  }

  const route = value as Partial<VoiceRouteMetadata>;
  return {
    stt: normalizeRouteInfo(route.stt, fallbackRoute.stt),
    tts: normalizeRouteInfo(route.tts, fallbackRoute.tts),
    ttsFallback: route.ttsFallback
      ? normalizeRouteInfo(route.ttsFallback, fallbackRoute.ttsFallback ?? undefined)
      : fallbackRoute.ttsFallback,
    capabilities: normalizeCapabilities(route.capabilities, fallbackRoute.capabilities),
  };
}

export function findCapability(
  capabilities: VoiceRouteCapability[],
  modality: 'stt' | 'tts',
  provider: string | null
) {
  const normalizedProvider = normalizeProviderName(provider);
  return capabilities.find(
    (capability) =>
      capability.modality === modality &&
      normalizeProviderName(capability.id) === normalizedProvider
  );
}

function selectionsEqual(left: VoiceRouteSelection, right: VoiceRouteSelection) {
  return (
    normalizeProviderName(left.provider) === normalizeProviderName(right.provider) &&
    (left.variant ?? null) === (right.variant ?? null)
  );
}

function buildResetMessage(capability: VoiceRouteCapability | undefined, modality: 'stt' | 'tts') {
  const label = capability?.label ?? 'That option';
  const surface = modality === 'stt' ? 'listening' : 'speaking';
  return `${label} isn't available right now, so the default ${surface} option is selected.`;
}

function buildVariantResetMessage(capability: VoiceRouteCapability) {
  const variantLabel = (capability.variantLabel || 'option').toLowerCase();
  return `That ${variantLabel} isn't available right now, so the default ${variantLabel} is selected.`;
}

function autoCorrectSelection(
  selection: VoiceRouteSelection,
  capability: VoiceRouteCapability | undefined
): { nextSelection: VoiceRouteSelection; message: string | null } {
  if (!selection.provider) {
    return {
      nextSelection: selection,
      message: null,
    };
  }

  if (!capability || !capability.available) {
    return {
      nextSelection: createEmptyVoiceRouteSelection(),
      message: null,
    };
  }

  if (!selection.variant) {
    return {
      nextSelection: selection,
      message: null,
    };
  }

  const hasVariant = capability.variants.some((variant) => variant.id === selection.variant);
  if (hasVariant) {
    return {
      nextSelection: selection,
      message: null,
    };
  }

  return {
    nextSelection: {
      provider: capability.id,
      variant: capability.variants[0]?.id ?? null,
    },
    message: buildVariantResetMessage(capability),
  };
}

export function autoCorrectRequestedVoiceRoute(
  requestedVoiceRoute: VoiceRouteState,
  voiceRoute: VoiceRouteMetadata
): VoiceRouteAutoCorrection {
  const sttCapability = findCapability(
    voiceRoute.capabilities,
    'stt',
    requestedVoiceRoute.stt.provider
  );
  const ttsCapability = findCapability(
    voiceRoute.capabilities,
    'tts',
    requestedVoiceRoute.tts.provider
  );

  const correctedStt = autoCorrectSelection(requestedVoiceRoute.stt, sttCapability);
  const correctedTts = autoCorrectSelection(requestedVoiceRoute.tts, ttsCapability);
  const sttMessage =
    correctedStt.message ||
    (requestedVoiceRoute.stt.provider && (!sttCapability || !sttCapability.available)
      ? buildResetMessage(sttCapability, 'stt')
      : null);
  const ttsMessage =
    correctedTts.message ||
    (requestedVoiceRoute.tts.provider && (!ttsCapability || !ttsCapability.available)
      ? buildResetMessage(ttsCapability, 'tts')
      : null);

  const correctedRoute: VoiceRouteState = {
    stt: correctedStt.nextSelection,
    tts: correctedTts.nextSelection,
  };

  const changed =
    !selectionsEqual(correctedRoute.stt, requestedVoiceRoute.stt) ||
    !selectionsEqual(correctedRoute.tts, requestedVoiceRoute.tts);

  const messages = [sttMessage, ttsMessage].filter(Boolean);
  return {
    changed,
    message:
      messages.length <= 1
        ? (messages[0] ?? null)
        : "Some voice choices aren't available right now, so the default options are selected.",
    requestedVoiceRoute: changed ? correctedRoute : requestedVoiceRoute,
  };
}

export function buildRouteDisplayLabel(info: VoiceRouteInfo) {
  return info.displayLabel || buildDisplayLabel(info.label, info.variant);
}

export function useVoiceRoute(appConfig: AppConfig) {
  const participants = useRemoteParticipants();

  return useMemo(() => {
    const fallbackRoute = buildFallbackVoiceRoute(appConfig);
    const agentParticipant = participants.find((participant) => participant.isAgent);
    if (!agentParticipant) {
      return {
        voiceRoute: fallbackRoute,
        hasLiveRoute: false,
        isLoading: true,
      };
    }

    try {
      const metadata = JSON.parse(agentParticipant.metadata || '{}') as {
        voiceRoute?: unknown;
      };
      if (!metadata.voiceRoute || typeof metadata.voiceRoute !== 'object') {
        return {
          voiceRoute: fallbackRoute,
          hasLiveRoute: false,
          isLoading: true,
        };
      }

      const route = metadata.voiceRoute as Partial<VoiceRouteMetadata>;
      const normalizedRoute = normalizeVoiceRouteMetadata(route, fallbackRoute);

      return {
        voiceRoute: normalizedRoute,
        hasLiveRoute: true,
        isLoading: false,
      };
    } catch {
      return {
        voiceRoute: fallbackRoute,
        hasLiveRoute: false,
        isLoading: true,
      };
    }
  }, [appConfig, participants]);
}
