/* VIVENTIUM START
 * Feature: Native speech-menu layering and nested Escape handling.
 * Purpose: Keep settings open while Radix handles its menu, then return focus on panel close.
 * VIVENTIUM END */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AdvancedVoiceSettings } from '@/components/app/advanced-voice-settings';
import type { UseCallSessionVoiceSettingsResult } from '@/hooks/useCallSessionVoiceSettings';
import type { VoiceRouteMetadata, VoiceRouteState } from '@/hooks/useVoiceRoute';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/livekit/dropdown-menu';

let utilities: HTMLStyleElement;
beforeEach(() => {
  utilities = document.createElement('style');
  // These are the pinned native Tailwind utility values used by the delivered components.
  utilities.textContent = '[class~="z-50"]{z-index:50}[class~="z-[100]"]{z-index:100}';
  document.head.appendChild(utilities);
});
afterEach(() => {
  cleanup();
  utilities.remove();
});

function Fixture({
  nested = false,
  onSelect = () => {},
}: {
  nested?: boolean;
  onSelect?: () => void;
}) {
  return (
    <details open style={{ position: 'fixed', zIndex: 90 }} aria-label="Advanced settings">
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger>Choose speech</DropdownMenuTrigger>
        <DropdownMenuContent aria-label="Providers">
          {nested ? (
            <DropdownMenuSub open>
              <DropdownMenuSubTrigger>Available provider</DropdownMenuSubTrigger>
              <DropdownMenuSubContent aria-label="Variants">
                <DropdownMenuItem onSelect={onSelect}>Current variant</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : (
            <>
              <DropdownMenuItem onSelect={onSelect}>Current choice</DropdownMenuItem>
              <DropdownMenuItem disabled onSelect={onSelect}>
                Unavailable choice
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </details>
  );
}

async function expectNativePortalAboveSettings(slot: string) {
  const content = document.querySelector(`[data-slot="${slot}"]`) as HTMLElement;
  expect(content).toBeTruthy();
  const parent = document.querySelector('details') as HTMLElement;
  const wrapper = content.closest('[data-radix-popper-content-wrapper]') as HTMLElement;
  await waitFor(() =>
    expect(Number(getComputedStyle(wrapper).zIndex)).toBeGreaterThan(
      Number(getComputedStyle(parent).zIndex)
    )
  );
  expect(getComputedStyle(wrapper).zIndex).toBe(getComputedStyle(content).zIndex);
}

describe('native speech menu layers', () => {
  it('places the provider portal above its advanced settings owner', async () => {
    render(<Fixture />);
    await expectNativePortalAboveSettings('dropdown-menu-content');
  });
  it('places a nested variant portal above the same owner', async () => {
    render(<Fixture nested />);
    await expectNativePortalAboveSettings('dropdown-menu-sub-content');
  });
  it('preserves enabled selection and keeps unavailable choices inactive', async () => {
    const selected = vi.fn();
    render(<Fixture onSelect={selected} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unavailable choice' }));
    expect(selected).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Current choice' }));
    await waitFor(() => expect(selected).toHaveBeenCalledOnce());
  });
});


const route: VoiceRouteMetadata = {
  stt: {
    provider: 'test-stt', label: 'Test listening', displayLabel: 'Test listening',
    isLocal: true, variant: 'test-model', variantLabel: 'Test model', variantType: 'model',
  },
  tts: {
    provider: 'test-tts', label: 'Test speaking', displayLabel: 'Test speaking',
    isLocal: true, variant: 'test-voice', variantLabel: 'Test voice', variantType: 'voice',
  },
  ttsFallback: null,
  capabilities: [
    { id: 'test-stt', modality: 'stt', label: 'Test listening', isLocal: true,
      available: true, unavailableReason: null, variantLabel: 'model',
      variants: [{ id: 'test-model', label: 'Test model' }] },
    { id: 'test-tts', modality: 'tts', label: 'Test speaking', isLocal: true,
      available: true, unavailableReason: null, variantLabel: 'voice',
      variants: [{ id: 'test-voice', label: 'Test voice' }] },
  ],
};
const configured: VoiceRouteState = {
  stt: { provider: 'test-stt', variant: 'test-model' },
  tts: { provider: 'test-tts', variant: 'test-voice' },
};

function renderActualSettings() {
  const changed = vi.fn();
  const settings = {
    configuredVoiceRoute: configured, selectionVoiceRoute: route,
    assistantRoute: null, isLoading: false, isSaving: false,
    error: null, notice: null, setRequestedVoiceRoute: changed,
  } as unknown as UseCallSessionVoiceSettingsResult;
  render(<AdvancedVoiceSettings settings={settings} />);
  const summary = screen.getByText('Advanced voice settings', { selector: 'summary' });
  const panel = summary.parentElement as HTMLDetailsElement;
  fireEvent.click(summary);
  expect(panel.open).toBe(true);
  return { panel, summary, changed };
}

describe('actual VoiceRouteControl nested Escape', () => {
  it.each([
    ['Test listening', 'Test model'],
    ['Test speaking', 'Test voice'],
  ])('closes the %s provider menu before closing settings', async (label) => {
    const { panel, summary, changed } = renderActualSettings();
    const trigger = screen.getByRole('button', { name: new RegExp(`^${label}`) });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const menu = await screen.findByRole('menu');
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(panel.open).toBe(true);
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(changed).not.toHaveBeenCalled();
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(panel.open).toBe(false);
    expect(summary).toHaveFocus();
  });

  it.each([
    ['Test listening', 'Test model'],
    ['Test speaking', 'Test voice'],
  ])('lets Radix dismiss the %s variant submenu without closing settings', async (label, variant) => {
    const { panel, summary, changed } = renderActualSettings();
    const trigger = screen.getByRole('button', { name: new RegExp(`^${label}`) });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const provider = await screen.findByRole('menuitem', { name: new RegExp(`^${label}`) });
    provider.focus();
    fireEvent.keyDown(provider, { key: 'ArrowRight' });
    const item = await screen.findByRole('menuitem', { name: variant });
    fireEvent.keyDown(item, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(panel.open).toBe(true);
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(changed).not.toHaveBeenCalled();
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(panel.open).toBe(false);
    expect(summary).toHaveFocus();
  });

  it('closes settings and returns summary focus for an unhandled panel Escape', () => {
    const { panel, summary, changed } = renderActualSettings();
    const close = screen.getByRole('button', { name: 'Close settings' });
    close.focus();
    fireEvent.keyDown(close, { key: 'Escape' });
    expect(panel.open).toBe(false);
    expect(summary).toHaveFocus();
    expect(changed).not.toHaveBeenCalled();
  });
});
