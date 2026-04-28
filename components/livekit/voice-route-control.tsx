'use client';

import { useMemo, useState } from 'react';
import {
  CaretDownIcon,
  CheckIcon,
  InfoIcon,
  SlidersHorizontalIcon,
} from '@phosphor-icons/react/dist/ssr';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/livekit/dropdown-menu';
import { Toggle } from '@/components/livekit/toggle';
import {
  type VoiceRouteCapability,
  type VoiceRouteInfo,
  type VoiceRouteMetadata,
  type VoiceRouteSelection,
  type VoiceRouteState,
  buildRouteDisplayLabel,
  normalizeProviderName,
} from '@/hooks/useVoiceRoute';
import { cn } from '@/lib/utils';

type VoiceRouteControlProps = {
  voiceRoute: VoiceRouteMetadata;
  requestedVoiceRoute: VoiceRouteState;
  onRequestedVoiceRouteChange?: (nextState: VoiceRouteState) => Promise<boolean> | void;
  editingDisabled?: boolean;
  hasLiveRoute?: boolean;
  isConnected?: boolean;
  savedRouteLoading?: boolean;
  liveRouteLoading?: boolean;
  isSaving?: boolean;
  error?: string | null;
  notice?: string | null;
  inline?: boolean;
  className?: string;
};

function getCapabilities(capabilities: VoiceRouteCapability[], modality: 'stt' | 'tts') {
  return capabilities.filter((capability) => capability.modality === modality);
}

function hasSavedChoice(selection: VoiceRouteSelection) {
  return Boolean(selection.provider || selection.variant);
}

function getVariantValue(
  capability: VoiceRouteCapability | undefined,
  currentVariant: string | null
) {
  if (!capability) {
    return currentVariant;
  }
  const hasCurrentVariant = capability.variants.some((variant) => variant.id === currentVariant);
  if (hasCurrentVariant) {
    return currentVariant;
  }
  return capability.variants[0]?.id ?? null;
}

function buildCapabilityDisplayLabel(
  capability: VoiceRouteCapability | undefined,
  variant: string | null,
  fallbackInfo: VoiceRouteInfo
) {
  const label = capability?.label || fallbackInfo.label;
  const variantLabel =
    variant && capability
      ? (capability.variants.find((entry) => entry.id === variant)?.label ?? variant)
      : variant;
  return variantLabel ? `${label} • ${variantLabel}` : label || buildRouteDisplayLabel(fallbackInfo);
}

function resolveRequestedInfo(
  fallbackInfo: VoiceRouteInfo,
  requested: VoiceRouteSelection,
  capabilities: VoiceRouteCapability[]
): VoiceRouteInfo {
  const provider =
    normalizeProviderName(requested.provider) || normalizeProviderName(fallbackInfo.provider);
  const capability = capabilities.find(
    (entry) => normalizeProviderName(entry.id) === normalizeProviderName(provider)
  );
  const variant = getVariantValue(capability, requested.variant ?? fallbackInfo.variant);
  const label = capability?.label || fallbackInfo.label;
  const variantLabel =
    variant && capability
      ? (capability.variants.find((entry) => entry.id === variant)?.label ?? variant)
      : variant;

  return {
    provider: capability?.id ?? requested.provider ?? fallbackInfo.provider,
    label,
    displayLabel: buildCapabilityDisplayLabel(capability, variant, fallbackInfo),
    isLocal: capability?.isLocal ?? fallbackInfo.isLocal,
    variant,
    variantLabel,
    variantType: capability?.variantLabel || fallbackInfo.variantType,
  };
}

function isSameRoute(left: VoiceRouteInfo, right: VoiceRouteInfo) {
  return (
    normalizeProviderName(left.provider) === normalizeProviderName(right.provider) &&
    (left.variant ?? null) === (right.variant ?? null)
  );
}

function RouteBadge({ isLocal }: { isLocal: boolean }) {
  const tooltip = isLocal
    ? 'Covered means this runs on your Mac, so using it will not add provider charges.'
    : 'Metered means this uses an online voice service, so it can add usage charges.';

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-semibold tracking-[0.18em] uppercase',
        isLocal
          ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
          : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
      )}
    >
      {isLocal ? 'Covered' : 'Metered'}
      <span className="group/voice-tooltip relative inline-flex">
        <button
          type="button"
          aria-label={tooltip}
          className="cursor-help rounded-full opacity-80 transition-opacity hover:opacity-100 focus:opacity-100 focus:outline-none"
        >
          <InfoIcon className="size-3" weight="bold" />
        </button>
        <span className="bg-popover text-popover-foreground border-border/80 pointer-events-none absolute top-full right-0 z-20 mt-2 w-52 rounded-2xl border px-3 py-2 text-[11px] normal-case opacity-0 shadow-[0_16px_40px_rgba(15,23,42,0.18)] transition-opacity duration-150 group-focus-within/voice-tooltip:opacity-100 group-hover/voice-tooltip:opacity-100">
          {tooltip}
        </span>
      </span>
    </span>
  );
}

function SummaryRow({
  label,
  info,
  className,
}: {
  label: string;
  info: VoiceRouteInfo;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'bg-background/90 border-border/70 flex items-center justify-between gap-3 rounded-3xl border px-4 py-4',
        className
      )}
    >
      <div>
        <p className="text-sm font-semibold">{label}</p>
        <p className="text-muted-foreground mt-1 text-sm">{buildRouteDisplayLabel(info)}</p>
      </div>
      <RouteBadge isLocal={info.isLocal} />
    </div>
  );
}

function SelectorRow({
  label,
  fallbackInfo,
  requested,
  capabilities,
  disabled,
  onChange,
}: {
  label: string;
  fallbackInfo: VoiceRouteInfo;
  requested: VoiceRouteSelection;
  capabilities: VoiceRouteCapability[];
  disabled: boolean;
  onChange: (provider: string | null, variant: string | null) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const resolvedInfo = resolveRequestedInfo(fallbackInfo, requested, capabilities);
  const activeProvider = normalizeProviderName(resolvedInfo.provider);
  const activeCapability = capabilities.find(
    (capability) => normalizeProviderName(capability.id) === activeProvider
  );
  const variantValue = getVariantValue(activeCapability, resolvedInfo.variant);
  const variantOptions = activeCapability?.variants ?? [];
  const selectedVariantLabel = resolvedInfo.variant
    ? (variantOptions.find((variant) => variant.id === variantValue)?.label ?? resolvedInfo.variant)
    : null;
  const triggerLabel = activeCapability?.label || resolvedInfo.label || 'Choose a provider';

  return (
    <div className="bg-background/80 border-border/60 rounded-[2rem] border px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="text-left">
          <p className="text-lg font-semibold tracking-[-0.02em]">{label}</p>
        </div>
        <RouteBadge isLocal={resolvedInfo.isLocal} />
      </div>

      <div className="mt-4">
        <DropdownMenu modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              className="bg-background border-input hover:bg-background flex min-h-16 w-full items-center justify-between rounded-[1.35rem] border px-5 py-3.5 text-left shadow-none transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-base font-medium">{triggerLabel}</span>
                {selectedVariantLabel ? (
                  <span className="text-muted-foreground truncate text-xs leading-5">
                    {selectedVariantLabel}
                  </span>
                ) : null}
              </span>
              <CaretDownIcon className="size-4 shrink-0" weight="bold" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            sideOffset={10}
            className="w-[min(22rem,calc(100vw-4rem))] rounded-[1.35rem]"
          >
            {capabilities.map((capability) => (
              <DropdownMenuSub key={capability.id}>
                <DropdownMenuSubTrigger
                  disabled={disabled || !capability.available}
                  className={cn(
                    'rounded-[1rem]',
                    normalizeProviderName(capability.id) === activeProvider &&
                      'bg-accent text-accent-foreground'
                  )}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="font-medium">{capability.label}</span>
                    {!capability.available && capability.unavailableReason ? (
                      <span className="text-muted-foreground text-xs leading-5">
                        {capability.unavailableReason}
                      </span>
                    ) : normalizeProviderName(capability.id) === activeProvider ? (
                      selectedVariantLabel ? (
                        <span className="text-muted-foreground text-xs leading-5">
                          {selectedVariantLabel}
                        </span>
                      ) : null
                    ) : null}
                  </span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-[min(22rem,calc(100vw-4rem))] rounded-[1.25rem]">
                  {capability.variants.map((variant) => {
                    const isSelected =
                      normalizeProviderName(capability.id) === activeProvider &&
                      variant.id === variantValue;

                    return (
                      <DropdownMenuItem
                        key={variant.id}
                        onSelect={() => {
                          onChange(capability.id, variant.id);
                          setMenuOpen(false);
                        }}
                        className={cn(isSelected && 'bg-accent/60')}
                      >
                        <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                          <span className="truncate">{variant.label}</span>
                          {isSelected ? (
                            <CheckIcon className="size-4 shrink-0" weight="bold" />
                          ) : null}
                        </span>
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function StatusMessage({
  children,
  tone = 'default',
}: {
  children: string;
  tone?: 'default' | 'warning';
}) {
  return (
    <p
      className={cn(
        'text-sm',
        tone === 'warning' ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground'
      )}
    >
      {children}
    </p>
  );
}

function VoiceRoutePanel({
  voiceRoute,
  requestedVoiceRoute,
  onRequestedVoiceRouteChange,
  editingDisabled,
  hasLiveRoute = false,
  isConnected = false,
  savedRouteLoading = false,
  liveRouteLoading = false,
  isSaving,
  error,
  notice,
  className,
}: Omit<VoiceRouteControlProps, 'inline'>) {
  const sttCapabilities = useMemo(
    () => getCapabilities(voiceRoute.capabilities, 'stt'),
    [voiceRoute.capabilities]
  );
  const ttsCapabilities = useMemo(
    () => getCapabilities(voiceRoute.capabilities, 'tts'),
    [voiceRoute.capabilities]
  );
  const readOnly = editingDisabled || !onRequestedVoiceRouteChange;
  const requestedStt = useMemo(
    () => resolveRequestedInfo(voiceRoute.stt, requestedVoiceRoute.stt, sttCapabilities),
    [requestedVoiceRoute.stt, sttCapabilities, voiceRoute.stt]
  );
  const requestedTts = useMemo(
    () => resolveRequestedInfo(voiceRoute.tts, requestedVoiceRoute.tts, ttsCapabilities),
    [requestedVoiceRoute.tts, ttsCapabilities, voiceRoute.tts]
  );
  const showingLiveSetup = readOnly;
  const liveStatus = hasLiveRoute
    ? null
    : liveRouteLoading && isConnected
      ? 'Waiting for Viventium…'
      : readOnly
        ? 'Voice details will appear when Viventium joins.'
        : null;
  const showBackupVoice = Boolean(voiceRoute.ttsFallback);
  const showVoiceChangeNote =
    readOnly &&
    hasLiveRoute &&
    (hasSavedChoice(requestedVoiceRoute.stt) || hasSavedChoice(requestedVoiceRoute.tts)) &&
    (!isSameRoute(requestedStt, voiceRoute.stt) || !isSameRoute(requestedTts, voiceRoute.tts));

  const handleChange = (
    modality: 'stt' | 'tts',
    provider: string | null,
    variant: string | null
  ) => {
    if (!onRequestedVoiceRouteChange) {
      return;
    }

    const nextState: VoiceRouteState = {
      ...requestedVoiceRoute,
      [modality]: {
        provider,
        variant,
      },
    };

    void onRequestedVoiceRouteChange(nextState);
  };

  return (
    <div
      className={cn(
        'border-border/70 bg-popover text-popover-foreground w-full overflow-hidden rounded-[28px] border shadow-[0_28px_80px_rgba(15,23,42,0.16)] dark:shadow-[0_28px_80px_rgba(2,8,23,0.45)]',
        className
      )}
    >
      <div className="border-border/60 px-6 py-5 text-center">
        <p className="text-muted-foreground text-[11px] font-bold tracking-[0.32em] uppercase">
          Voice
        </p>
        <p className="mt-3 text-[clamp(1.4rem,2vw,2rem)] leading-tight font-medium tracking-[-0.03em]">
          {readOnly ? 'Current voice setup.' : 'Choose how Viventium listens and speaks.'}
        </p>
      </div>

      <div className="space-y-4 px-6 py-5">
        {showingLiveSetup ? (
          <>
            {hasLiveRoute ? (
              <>
                <SummaryRow label="Listening" info={voiceRoute.stt} />
                <SummaryRow label="Speaking" info={voiceRoute.tts} />
              </>
            ) : liveStatus ? (
              <div className="bg-background/90 border-border/70 rounded-3xl border px-4 py-3">
                <StatusMessage>{liveStatus}</StatusMessage>
              </div>
            ) : null}

            {showVoiceChangeNote ? (
              <div className="bg-background/90 border-border/70 rounded-3xl border px-4 py-3">
                <StatusMessage>Changes start next call.</StatusMessage>
              </div>
            ) : null}
          </>
        ) : savedRouteLoading ? (
          <div className="bg-background/80 border-border/60 rounded-[2rem] border px-4 py-3">
            <StatusMessage>Loading your voice settings…</StatusMessage>
          </div>
        ) : (
          <div className="space-y-3">
            <SelectorRow
              label="Listening"
              fallbackInfo={voiceRoute.stt}
              requested={requestedVoiceRoute.stt}
              capabilities={sttCapabilities}
              disabled={savedRouteLoading || Boolean(isSaving)}
              onChange={(provider, variant) => handleChange('stt', provider, variant)}
            />
            <SelectorRow
              label="Speaking"
              fallbackInfo={voiceRoute.tts}
              requested={requestedVoiceRoute.tts}
              capabilities={ttsCapabilities}
              disabled={savedRouteLoading || Boolean(isSaving)}
              onChange={(provider, variant) => handleChange('tts', provider, variant)}
            />
          </div>
        )}

        {showBackupVoice && voiceRoute.ttsFallback ? (
          <div className="bg-background/80 border-border/60 rounded-[2rem] border px-5 py-4 text-sm">
            <span className="font-semibold">Backup voice:</span>{' '}
            <span className="text-muted-foreground">
              {buildRouteDisplayLabel(voiceRoute.ttsFallback)}
            </span>
          </div>
        ) : null}

        {!readOnly && isSaving ? <StatusMessage>Saving your voice settings…</StatusMessage> : null}
        {!readOnly && notice ? <StatusMessage tone="warning">{notice}</StatusMessage> : null}
        {error ? <StatusMessage tone="warning">{error}</StatusMessage> : null}
      </div>
    </div>
  );
}

export function VoiceRouteControl({ inline = false, className, ...props }: VoiceRouteControlProps) {
  const [open, setOpen] = useState(false);

  if (inline) {
    return <VoiceRoutePanel {...props} className={className} />;
  }

  return (
    <div className={cn('relative', className)}>
      <Toggle
        type="button"
        size="icon"
        variant="secondary"
        pressed={open}
        aria-label="Voice"
        title="Voice"
        onPressedChange={setOpen}
      >
        <SlidersHorizontalIcon weight="bold" />
        <span className="sr-only">Voice</span>
      </Toggle>

      {open ? (
        <VoiceRoutePanel
          {...props}
          className="absolute right-0 bottom-[calc(100%+12px)] z-[85] w-[min(92vw,34rem)]"
        />
      ) : null}
    </div>
  );
}
