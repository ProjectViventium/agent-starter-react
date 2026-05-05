'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type VoiceRouteMetadata,
  type VoiceRouteState,
  autoCorrectRequestedVoiceRoute,
  createEmptyVoiceRouteState,
  normalizeVoiceRouteMetadata,
  normalizeVoiceRouteState,
} from '@/hooks/useVoiceRoute';

type VoiceSettingsResponse = {
  requestedVoiceRoute?: unknown;
  savedVoiceRoute?: unknown;
  selectionVoiceRoute?: unknown;
  assistantRoute?: unknown;
  message?: string;
  error?: string;
};

const INITIAL_LOAD_RETRY_MS = 1500;
const INITIAL_LOAD_MAX_ATTEMPTS = 2;

export type AssistantRouteAssignment = {
  provider: string | null;
  model: string | null;
};

export type AssistantRouteInfo = {
  primary: AssistantRouteAssignment;
  voiceCallLlm: AssistantRouteAssignment | null;
  fallbackLlm: AssistantRouteAssignment | null;
  voiceFallbackLlm?: AssistantRouteAssignment | null;
  effective: AssistantRouteAssignment;
  inheritsPrimary: boolean;
};

export type UseCallSessionVoiceSettingsResult = {
  requestedVoiceRoute: VoiceRouteState;
  savedVoiceRoute: VoiceRouteState;
  selectionVoiceRoute: VoiceRouteMetadata | null;
  assistantRoute: AssistantRouteInfo | null;
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
  notice: string | null;
  setRequestedVoiceRoute: (nextRoute: VoiceRouteState) => Promise<boolean>;
};

function getErrorMessage(payload: VoiceSettingsResponse | null | undefined, fallback: string) {
  if (typeof payload?.message === 'string' && payload.message.trim()) {
    return payload.message.trim();
  }
  if (typeof payload?.error === 'string' && payload.error.trim()) {
    return payload.error.trim();
  }
  return fallback;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isLikelyFetchNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.trim().toLowerCase();
  return (
    message === 'failed to fetch' ||
    message === 'fetch failed' ||
    message === 'load failed' ||
    message.includes('networkerror')
  );
}

function formatVoiceSettingsError(error: unknown, fallback: string, retrying = false): string {
  if (isLikelyFetchNetworkError(error)) {
    return retrying
      ? 'Viventium is reconnecting to the voice runtime. Retrying voice settings...'
      : 'Viventium could not reach the voice runtime for voice settings. Check the connection and retry.';
  }
  return error instanceof Error && error.message.trim() ? error.message.trim() : fallback;
}

function normalizeAssistantRouteAssignment(value: unknown): AssistantRouteAssignment | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const assignment = value as Partial<AssistantRouteAssignment>;
  const provider =
    typeof assignment.provider === 'string' && assignment.provider.trim()
      ? assignment.provider.trim()
      : null;
  const model =
    typeof assignment.model === 'string' && assignment.model.trim()
      ? assignment.model.trim()
      : null;

  if (!provider || !model) {
    return null;
  }

  return { provider, model };
}

function normalizeAssistantRouteInfo(value: unknown): AssistantRouteInfo | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const route = value as Partial<AssistantRouteInfo>;
  const primary = normalizeAssistantRouteAssignment(route.primary);
  const effective = normalizeAssistantRouteAssignment(route.effective);
  const voiceCallLlm = normalizeAssistantRouteAssignment(route.voiceCallLlm);
  const fallbackLlm = normalizeAssistantRouteAssignment(route.fallbackLlm);
  const voiceFallbackLlm = normalizeAssistantRouteAssignment(route.voiceFallbackLlm);

  if (!primary || !effective) {
    return null;
  }

  return {
    primary,
    voiceCallLlm,
    fallbackLlm,
    voiceFallbackLlm,
    effective,
    inheritsPrimary:
      typeof route.inheritsPrimary === 'boolean' ? route.inheritsPrimary : voiceCallLlm === null,
  };
}

async function requestVoiceSettings(
  method: 'GET' | 'POST',
  callSessionId: string,
  requestedVoiceRoute?: VoiceRouteState,
  signal?: AbortSignal
) {
  const url =
    method === 'GET'
      ? `/api/call-session-voice-settings?callSessionId=${encodeURIComponent(callSessionId)}`
      : '/api/call-session-voice-settings';

  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
    body:
      method === 'POST'
        ? JSON.stringify({
            callSessionId,
            requestedVoiceRoute,
          })
        : undefined,
    cache: 'no-store',
    signal,
  });

  const payload = (await response.json().catch(() => ({}))) as VoiceSettingsResponse;
  if (!response.ok) {
    throw new Error(
      getErrorMessage(payload, `Voice settings request failed (${response.status}).`)
    );
  }

  return {
    requestedVoiceRoute: normalizeVoiceRouteState(payload.requestedVoiceRoute),
    savedVoiceRoute: normalizeVoiceRouteState(payload.savedVoiceRoute),
    selectionVoiceRoute: payload.selectionVoiceRoute,
    assistantRoute: normalizeAssistantRouteInfo(payload.assistantRoute),
  };
}

export function useCallSessionVoiceSettings(
  callSessionId: string | null,
  fallbackVoiceRoute: VoiceRouteMetadata
): UseCallSessionVoiceSettingsResult {
  const [requestedVoiceRoute, setRequestedVoiceRouteState] = useState<VoiceRouteState>(
    createEmptyVoiceRouteState()
  );
  const [savedVoiceRoute, setSavedVoiceRoute] = useState<VoiceRouteState>(
    createEmptyVoiceRouteState()
  );
  const [selectionVoiceRoute, setSelectionVoiceRoute] = useState<VoiceRouteMetadata | null>(null);
  const [assistantRoute, setAssistantRoute] = useState<AssistantRouteInfo | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const autoCorrectionRef = useRef<string | null>(null);

  const normalizedSelectionVoiceRoute = useMemo(() => {
    if (!selectionVoiceRoute) {
      return null;
    }
    return normalizeVoiceRouteMetadata(selectionVoiceRoute, fallbackVoiceRoute);
  }, [fallbackVoiceRoute, selectionVoiceRoute]);

  const normalizeSelectionRoute = useCallback(
    (value: unknown) => {
      if (!value || typeof value !== 'object') {
        return null;
      }
      return normalizeVoiceRouteMetadata(value, fallbackVoiceRoute);
    },
    [fallbackVoiceRoute]
  );

  useEffect(() => {
    if (!callSessionId) {
      setRequestedVoiceRouteState(createEmptyVoiceRouteState());
      setSavedVoiceRoute(createEmptyVoiceRouteState());
      setSelectionVoiceRoute(null);
      setAssistantRoute(null);
      setIsLoading(false);
      setIsSaving(false);
      setError(null);
      setNotice(null);
      autoCorrectionRef.current = null;
      return;
    }

    const controller = new AbortController();
    let retryTimeoutId: ReturnType<typeof setTimeout> | null = null;
    setIsLoading(true);
    setError(null);
    setNotice(null);
    setAssistantRoute(null);
    autoCorrectionRef.current = null;

    const loadVoiceSettings = (attempt: number) => {
      requestVoiceSettings('GET', callSessionId, undefined, controller.signal)
        .then((payload) => {
          setRequestedVoiceRouteState(payload.requestedVoiceRoute);
          setSavedVoiceRoute(payload.savedVoiceRoute);
          setSelectionVoiceRoute(normalizeSelectionRoute(payload.selectionVoiceRoute));
          setAssistantRoute(payload.assistantRoute);
          setError(null);
        })
        .catch((nextError) => {
          if (isAbortError(nextError)) {
            return;
          }
          const shouldRetry =
            isLikelyFetchNetworkError(nextError) && attempt + 1 < INITIAL_LOAD_MAX_ATTEMPTS;
          setError(
            formatVoiceSettingsError(nextError, 'Unable to load voice settings.', shouldRetry)
          );
          if (shouldRetry) {
            retryTimeoutId = setTimeout(() => {
              retryTimeoutId = null;
              loadVoiceSettings(attempt + 1);
            }, INITIAL_LOAD_RETRY_MS);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted && retryTimeoutId === null) {
            setIsLoading(false);
          }
        });
    };

    loadVoiceSettings(0);

    return () => {
      controller.abort();
      if (retryTimeoutId !== null) {
        clearTimeout(retryTimeoutId);
      }
    };
  }, [callSessionId, normalizeSelectionRoute]);

  useEffect(() => {
    if (!normalizedSelectionVoiceRoute || isLoading || isSaving) {
      return;
    }

    const correction = autoCorrectRequestedVoiceRoute(
      requestedVoiceRoute,
      normalizedSelectionVoiceRoute
    );
    if (!correction.changed) {
      autoCorrectionRef.current = null;
      return;
    }

    const correctionKey = JSON.stringify(correction.requestedVoiceRoute);
    if (autoCorrectionRef.current === correctionKey) {
      return;
    }
    autoCorrectionRef.current = correctionKey;
    setNotice(correction.message);
    setRequestedVoiceRouteState(correction.requestedVoiceRoute);

    if (!callSessionId) {
      return;
    }

    setIsSaving(true);
    setError(null);
    requestVoiceSettings('POST', callSessionId, correction.requestedVoiceRoute)
      .then((payload) => {
        setRequestedVoiceRouteState(payload.requestedVoiceRoute);
        setSavedVoiceRoute(payload.savedVoiceRoute);
        setSelectionVoiceRoute(normalizeSelectionRoute(payload.selectionVoiceRoute));
        setAssistantRoute(payload.assistantRoute);
      })
      .catch((nextError) => {
        setError(formatVoiceSettingsError(nextError, 'Unable to save voice settings.'));
      })
      .finally(() => {
        setIsSaving(false);
      });
  }, [
    callSessionId,
    isLoading,
    isSaving,
    normalizeSelectionRoute,
    normalizedSelectionVoiceRoute,
    requestedVoiceRoute,
  ]);

  const setRequestedVoiceRoute = useCallback(
    async (nextRoute: VoiceRouteState) => {
      const normalizedRoute = normalizeVoiceRouteState(nextRoute);
      autoCorrectionRef.current = null;
      setNotice(null);
      setRequestedVoiceRouteState(normalizedRoute);

      if (!callSessionId) {
        return true;
      }

      setIsSaving(true);
      setError(null);
      try {
        const payload = await requestVoiceSettings('POST', callSessionId, normalizedRoute);
        setRequestedVoiceRouteState(payload.requestedVoiceRoute);
        setSavedVoiceRoute(payload.savedVoiceRoute);
        setSelectionVoiceRoute(normalizeSelectionRoute(payload.selectionVoiceRoute));
        setAssistantRoute(payload.assistantRoute);
        return true;
      } catch (nextError) {
        setError(formatVoiceSettingsError(nextError, 'Unable to save voice settings.'));
        return false;
      } finally {
        setIsSaving(false);
      }
    },
    [callSessionId, normalizeSelectionRoute]
  );

  return {
    requestedVoiceRoute,
    savedVoiceRoute,
    selectionVoiceRoute: normalizedSelectionVoiceRoute,
    assistantRoute,
    isLoading,
    isSaving,
    error,
    notice,
    setRequestedVoiceRoute,
  };
}
