'use client';

import { useMemo } from 'react';
import { useRemoteParticipants } from '@livekit/components-react';

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

export function createEmptyVoiceRouteMetadata(): VoiceRouteMetadata {
  return {
    stt: normalizeRouteInfo(null),
    tts: normalizeRouteInfo(null),
    ttsFallback: null,
    capabilities: [],
  };
}

/**
 * Normalises a `voiceRoute` object from the gateway (agent metadata or `/capabilities`).
 * Missing fields are filled from `fallbackRoute` when given, otherwise left empty: the page
 * never invents providers, models or voices.
 */
export function normalizeVoiceRouteMetadata(
  value: unknown,
  fallbackRoute?: VoiceRouteMetadata | null
): VoiceRouteMetadata {
  const fallback = fallbackRoute ?? createEmptyVoiceRouteMetadata();
  if (!value || typeof value !== 'object') {
    return fallback;
  }

  const route = value as Partial<VoiceRouteMetadata>;
  return {
    stt: normalizeRouteInfo(route.stt, fallback.stt),
    tts: normalizeRouteInfo(route.tts, fallback.tts),
    ttsFallback: route.ttsFallback
      ? normalizeRouteInfo(route.ttsFallback, fallback.ttsFallback ?? undefined)
      : fallback.ttsFallback,
    capabilities: normalizeCapabilities(route.capabilities, fallback.capabilities),
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

export function buildRouteDisplayLabel(info: VoiceRouteInfo) {
  return info.displayLabel || buildDisplayLabel(info.label, info.variant);
}

/**
 * The voice route the call is using, read from the agent participant's metadata (`voiceRoute`).
 *
 * `fallbackRoute` is what to show before the agent has published its route: pass the
 * `selectionVoiceRoute` from `useCallSessionVoiceSettings` (the gateway's own catalog, CP-HL-015),
 * or nothing. There is no built-in provider catalog any more.
 */
export function useVoiceRoute(fallbackRoute: VoiceRouteMetadata | null = null) {
  const participants = useRemoteParticipants();

  return useMemo(() => {
    const pending = {
      voiceRoute: fallbackRoute,
      hasLiveRoute: false,
      isLoading: true,
    };
    const agentParticipant = participants.find((participant) => participant.isAgent);
    if (!agentParticipant) {
      return pending;
    }

    try {
      const metadata = JSON.parse(agentParticipant.metadata || '{}') as {
        voiceRoute?: unknown;
      };
      if (!metadata.voiceRoute || typeof metadata.voiceRoute !== 'object') {
        return pending;
      }

      return {
        voiceRoute: normalizeVoiceRouteMetadata(metadata.voiceRoute, fallbackRoute),
        hasLiveRoute: true,
        isLoading: false,
      };
    } catch {
      return pending;
    }
  }, [fallbackRoute, participants]);
}
