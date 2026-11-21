'use client';

/*
 * The voice picker: who is listening and who is speaking in this call
 * (CP-CMP-041 … 046, seam S7).
 *
 * One button that shows the current choice at a glance (two small provider marks) and one panel
 * with two sections, "Listening" and "Voice": a card per provider, and under the chosen provider
 * its models or voices. Everything shown comes from the voice-settings response
 * (`useCallSessionVoiceSettings`) and, during a call, from what the voice agent reports
 * (`useVoiceRoute`); `lib/voice-providers` only adds names, one-line descriptions and logos.
 *
 * When a choice takes effect: the voice worker reads the call's route once, when it starts for
 * this call. A choice made before Start is used by this call. A choice made during a call is
 * saved for this call but cannot change the running worker, so the panel says so and marks
 * what is "In use" separately from what is chosen.
 */
import { type ReactNode } from 'react';
import { ConnectionState } from 'livekit-client';
import { CheckIcon, EarIcon, LaptopIcon, SlidersHorizontalIcon, Volume2Icon } from 'lucide-react';
import { useSessionContext } from '@livekit/components-react';
import { DeviceSoundControl } from '@/components/app/device-sound-control';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import type {
  AssistantRouteAssignment,
  UseCallSessionVoiceSettingsResult,
} from '@/hooks/useCallSessionVoiceSettings';
import type { DeviceSoundMode, DeviceSoundSettings } from '@/hooks/useDeviceSoundMode';
import {
  type VoiceRouteCapability,
  type VoiceRouteMetadata,
  type VoiceRouteSelection,
  buildRouteDisplayLabel,
  normalizeProviderName,
  useVoiceRoute,
} from '@/hooks/useVoiceRoute';
import { cn } from '@/lib/shadcn/utils';
import { type ProviderMark, type VoiceModality, presentProvider } from '@/lib/voice-providers';

/** Where the call is: not started, running (connecting or connected), or over. */
export type VoicePickerPhase = 'before' | 'live' | 'ended';

const PHASE_TEXT: Record<VoicePickerPhase, string> = {
  before: 'Choose how Viventium listens and speaks. Used when you start this call.',
  live: 'A running call keeps its voice. Your choice is saved for this call and used the next time it starts.',
  ended: 'This call has ended.',
};

const SECTIONS: ReadonlyArray<{ modality: VoiceModality; title: string; Icon: typeof EarIcon }> = [
  { modality: 'stt', title: 'Listening', Icon: EarIcon },
  { modality: 'tts', title: 'Voice', Icon: Volume2Icon },
];

function sameProvider(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a) && normalizeProviderName(a) === normalizeProviderName(b);
}

function ProviderMarkTile({ mark, className }: { mark: ProviderMark; className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-provider-mark={mark.kind}
      className={cn(
        'bg-muted text-foreground flex size-9 shrink-0 items-center justify-center rounded-xl text-sm font-semibold',
        className
      )}
    >
      {mark.kind === 'logo' ? (
        // The logo files are one colour; drawn as a mask so they follow the theme's text colour.
        <span
          data-provider-logo={mark.src}
          className="size-[55%] bg-current"
          style={{
            mask: `url(${mark.src}) center / contain no-repeat`,
            WebkitMask: `url(${mark.src}) center / contain no-repeat`,
          }}
        />
      ) : mark.kind === 'device' ? (
        <LaptopIcon className="size-[55%]" />
      ) : (
        mark.letter
      )}
    </span>
  );
}

/** "Covered" (runs on this Mac) or "Metered" (online service), as today (CP-CMP-044). */
function CostBadge({ isLocal }: { isLocal: boolean }) {
  return (
    <span
      title={
        isLocal
          ? 'Covered: runs on this Mac, so it adds no provider charges.'
          : 'Metered: an online service that can add usage charges.'
      }
      className={cn(
        'rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wider uppercase',
        isLocal
          ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
          : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
      )}
    >
      {isLocal ? 'Covered' : 'Metered'}
    </span>
  );
}

function variantFor(capability: VoiceRouteCapability, current: string | null): string | null {
  return capability.variants.some((variant) => variant.id === current)
    ? current
    : (capability.variants[0]?.id ?? null);
}

function ProviderCard({
  capability,
  chosen,
  inUse,
  locked,
  onChoose,
  chosenVariant,
}: {
  capability: VoiceRouteCapability;
  chosen: boolean;
  /** The running call is using this provider. */
  inUse: boolean;
  /** Nothing can be chosen right now (saving, or the call is over). */
  locked: boolean;
  onChoose: (variant: string | null) => void;
  chosenVariant: string | null;
}) {
  const { name, description, mark } = presentProvider(capability, capability.modality);
  const unavailable = !capability.available;
  const blocked = unavailable || locked;
  return (
    <div
      data-chosen={chosen}
      className={cn(
        'rounded-2xl border transition-colors motion-reduce:transition-none',
        chosen ? 'border-primary bg-primary/10' : 'border-border',
        unavailable && 'opacity-60'
      )}
    >
      <button
        type="button"
        aria-pressed={chosen}
        aria-disabled={blocked}
        onClick={() => {
          if (!blocked && !chosen) onChoose(variantFor(capability, chosenVariant));
        }}
        className={cn(
          'focus-visible:ring-ring/50 flex w-full items-start gap-3 rounded-2xl p-3 text-left outline-none focus-visible:ring-[3px]',
          blocked ? 'cursor-not-allowed' : !chosen && 'hover:bg-muted/60'
        )}
      >
        <ProviderMarkTile mark={mark} />
        <span className="min-w-0 grow">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span data-provider-name className="text-sm font-semibold">
              {name}
            </span>
            <span className="text-muted-foreground text-xs">
              {capability.isLocal ? 'On this Mac' : 'Cloud'}
            </span>
            <CostBadge isLocal={capability.isLocal} />
            {inUse ? (
              <span className="bg-foreground text-background rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wider uppercase">
                In use
              </span>
            ) : null}
          </span>
          <span className="text-muted-foreground mt-1 block text-xs leading-5">
            {unavailable
              ? `Not available: ${capability.unavailableReason ?? 'it is not set up on this Mac.'}`
              : description}
          </span>
        </span>
        {chosen ? (
          <CheckIcon aria-hidden="true" className="text-primary mt-1 size-4 shrink-0" />
        ) : null}
      </button>

      {chosen && capability.variants.length > 0 ? (
        <div
          role="group"
          aria-label={`${name} ${capability.variantLabel.toLowerCase()}`}
          className="flex flex-wrap items-center gap-1.5 px-3 pb-3"
        >
          <span className="text-muted-foreground mr-1 text-xs">{capability.variantLabel}</span>
          {capability.variants.map((variant) => {
            const selected = variant.id === chosenVariant;
            return (
              <button
                key={variant.id}
                type="button"
                aria-pressed={selected}
                aria-disabled={locked}
                onClick={() => {
                  if (!locked && !selected) onChoose(variant.id);
                }}
                className={cn(
                  'focus-visible:ring-ring/50 rounded-full border px-2.5 py-1 text-xs outline-none focus-visible:ring-[3px]',
                  selected
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-background hover:bg-muted',
                  locked && 'cursor-not-allowed'
                )}
              >
                {variant.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function AssistantLine({ label, route }: { label: string; route: AssistantRouteAssignment }) {
  return (
    <p>
      {label}: {route.providerLabel ?? route.provider} · {route.modelLabel ?? route.model}
      {route.effort ? (
        <>
          {' '}
          · <span className="capitalize">{route.effort}</span>
        </>
      ) : null}
    </p>
  );
}

/** Who is listening and who is speaking, for the two small marks on the button. */
function currentChoice(
  catalog: VoiceRouteCapability[],
  selection: Record<VoiceModality, string | null>
) {
  return SECTIONS.flatMap(({ modality, title, Icon }) => {
    const capability = catalog.find(
      (item) => item.modality === modality && sameProvider(item.id, selection[modality])
    );
    return capability ? [{ modality, title, Icon, ...presentProvider(capability, modality) }] : [];
  });
}

export interface VoicePickerProps {
  /** Voice settings of this call; leave out when the page was opened without a call. */
  settings?: UseCallSessionVoiceSettingsResult | null;
  /** What the voice agent reports it is using; `null` until it has joined. */
  liveRoute?: VoiceRouteMetadata | null;
  phase?: VoicePickerPhase;
  deviceSound: DeviceSoundSettings;
  /** The sound mode the running call uses; `null` when no call has started. */
  activeSoundMode?: DeviceSoundMode | null;
  className?: string;
}

/** The "Voice" button and its panel. */
export function VoicePicker({
  settings = null,
  liveRoute = null,
  phase = 'before',
  deviceSound,
  activeSoundMode,
  className,
}: VoicePickerProps) {
  const catalog = settings?.selectionVoiceRoute?.capabilities ?? liveRoute?.capabilities ?? [];
  const chosen: Record<VoiceModality, VoiceRouteSelection> = settings?.configuredVoiceRoute ?? {
    stt: { provider: null, variant: null },
    tts: { provider: null, variant: null },
  };
  const live = phase === 'live' ? liveRoute : null;
  const locked = phase === 'ended' || Boolean(settings?.isSaving);
  const assistant = settings?.assistantRoute ?? null;
  const backupAssistant = assistant?.voiceFallbackLlm ?? assistant?.fallbackLlm ?? null;
  const backupVoice = (liveRoute ?? settings?.selectionVoiceRoute)?.ttsFallback ?? null;

  const choose = (modality: VoiceModality, provider: string, variant: string | null) => {
    if (!settings) return;
    void settings.setRequestedVoiceRoute({
      ...settings.requestedVoiceRoute,
      [modality]: { provider, variant },
    });
  };

  // During a call the button shows what the call is using; otherwise what is chosen.
  const current = currentChoice(catalog, {
    stt: live?.stt.provider ?? chosen.stt.provider,
    tts: live?.tts.provider ?? chosen.tts.provider,
  });

  let status: ReactNode = null;
  if (settings?.isSaving) {
    status = <p role="status">Saving your choice…</p>;
  } else if (settings?.error) {
    status = (
      <p role="alert" className="text-amber-700 dark:text-amber-300">
        {settings.error}
      </p>
    );
  } else if (settings?.isLoading) {
    status = <p role="status">Loading voice options…</p>;
  } else if (settings && catalog.length === 0) {
    status = <p role="status">Voice options are not available right now.</p>;
  }

  return (
    <Sheet>
      <SheetTrigger
        aria-label={[
          'Voice settings',
          ...current.map((part) => `${part.title}: ${part.name}`),
        ].join('. ')}
        className={cn(
          'bg-accent border-border text-foreground hover:bg-foreground/10 focus-visible:ring-ring/50 inline-flex h-9 items-center gap-2 rounded-full border px-3 text-sm font-medium outline-none focus-visible:ring-[3px]',
          className
        )}
      >
        {current.length === 0 ? (
          <>
            <SlidersHorizontalIcon aria-hidden="true" className="size-4" />
            Voice
          </>
        ) : (
          current.map((part) => (
            <span key={part.modality} className="flex items-center gap-1">
              <part.Icon aria-hidden="true" className="text-muted-foreground size-3.5" />
              <ProviderMarkTile mark={part.mark} className="size-6 rounded-lg text-[11px]" />
            </span>
          ))
        )}
      </SheetTrigger>
      <SheetContent
        side="bottom"
        closeLabel="Close voice settings"
        className="mx-auto max-h-[85svh] w-full max-w-2xl gap-0 overflow-y-auto overscroll-contain rounded-t-3xl border-x pb-6"
      >
        <SheetHeader className="pr-14">
          <SheetTitle>Voice</SheetTitle>
          <SheetDescription>
            {settings ? PHASE_TEXT[phase] : 'Open a call from Viventium to choose its voice.'}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-6 px-4">
          {status ? <div className="text-muted-foreground text-sm">{status}</div> : null}

          {settings
            ? SECTIONS.map(({ modality, title, Icon }) => {
                const providers = catalog.filter((item) => item.modality === modality);
                if (providers.length === 0) return null;
                return (
                  <section key={modality} aria-labelledby={`voice-picker-${modality}`}>
                    <h3
                      id={`voice-picker-${modality}`}
                      className="mb-2 flex items-center gap-2 text-sm font-semibold"
                    >
                      <Icon aria-hidden="true" className="size-4" />
                      {title}
                    </h3>
                    <div
                      role="group"
                      aria-labelledby={`voice-picker-${modality}`}
                      aria-busy={settings.isSaving}
                      className="grid grid-cols-1 gap-2 sm:grid-cols-2"
                    >
                      {providers.map((capability) => (
                        <ProviderCard
                          key={capability.id}
                          capability={capability}
                          chosen={sameProvider(capability.id, chosen[modality].provider)}
                          chosenVariant={chosen[modality].variant}
                          inUse={sameProvider(capability.id, live?.[modality].provider)}
                          locked={locked}
                          onChoose={(variant) => choose(modality, capability.id, variant)}
                        />
                      ))}
                    </div>
                    {modality === 'tts' && backupVoice ? (
                      <p className="text-muted-foreground mt-2 text-xs">
                        Backup voice: {buildRouteDisplayLabel(backupVoice)}
                      </p>
                    ) : null}
                  </section>
                );
              })
            : null}

          <DeviceSoundControl deviceSound={deviceSound} activeSoundMode={activeSoundMode} />

          {settings ? (
            <div className="text-muted-foreground space-y-1 text-xs leading-5">
              {assistant ? <AssistantLine label="Assistant" route={assistant.effective} /> : null}
              {backupAssistant ? (
                <AssistantLine label="Backup assistant" route={backupAssistant} />
              ) : null}
              <p>
                Covered runs on this Mac and adds no provider charges. Metered is an online service
                that can add usage charges.
              </p>
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** The picker inside a call session: adds what the voice agent reports and where the call is. */
export function CallVoicePicker({
  settings,
  ended,
  ...props
}: Omit<VoicePickerProps, 'liveRoute' | 'phase' | 'settings'> & {
  settings: UseCallSessionVoiceSettingsResult | null;
  ended: boolean;
}) {
  const { connectionState } = useSessionContext();
  const { voiceRoute, hasLiveRoute } = useVoiceRoute(settings?.selectionVoiceRoute ?? null);
  return (
    <VoicePicker
      {...props}
      settings={settings}
      liveRoute={hasLiveRoute ? voiceRoute : null}
      phase={ended ? 'ended' : connectionState !== ConnectionState.Disconnected ? 'live' : 'before'}
    />
  );
}
