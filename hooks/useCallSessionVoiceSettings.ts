'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type VoiceRouteMetadata,
  type VoiceRouteState,
  createEmptyVoiceRouteState,
  normalizeProviderName,
  normalizeVoiceRouteMetadata,
  normalizeVoiceRouteState,
} from '@/hooks/useVoiceRoute';
import { callBrowserCapabilityHeaders } from '@/lib/call-browser-capability';
import { type CallIssue, CallRequestError, callIssueFromResponse } from '@/lib/call-start';

type VoiceSettingsResponse = {
  requestedVoiceRoute?: unknown;
  savedVoiceRoute?: unknown;
  selectionVoiceRoute?: unknown;
  assistantRoute?: unknown;
  message?: string;
  error?: string;
  code?: unknown;
  retryable?: unknown;
};

const INITIAL_LOAD_RETRY_MS = 1500;
const INITIAL_LOAD_MAX_ATTEMPTS = 2;
const VOICE_SETTINGS_REQUEST_TIMEOUT_MS = 5000;

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
  configuredVoiceRoute: VoiceRouteState;
  selectionVoiceRoute: VoiceRouteMetadata | null;
  assistantRoute: AssistantRouteInfo | null;
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
  issue: CallIssue | null;
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

class VoiceSettingsTimeoutError extends CallRequestError {
  constructor() {
    super(
      {
        kind: 'gateway_down',
        message: 'Viventium could not load voice settings before the voice runtime responded.',
      },
      true
    );
    this.name = 'VoiceSettingsTimeoutError';
  }
}

function isVoiceSettingsTimeoutError(error: unknown): error is VoiceSettingsTimeoutError {
  return error instanceof VoiceSettingsTimeoutError;
}

function isTransientVoiceSettingsLoadError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    isVoiceSettingsTimeoutError(error) ||
    (error instanceof CallRequestError && error.retryable)
  );
}

function formatVoiceSettingsError(error: unknown, fallback: string, retrying = false): string {
  if (error instanceof TypeError) {
    return retrying
      ? 'Viventium is reconnecting to the voice runtime. Retrying voice settings...'
      : 'Viventium could not reach the voice runtime for voice settings. Check the connection and retry.';
  }
  if (isVoiceSettingsTimeoutError(error)) {
    return retrying
      ? 'Viventium is reconnecting to the voice runtime. Retrying voice settings...'
      : error.message;
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

  const requestController = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    requestController.abort();
  }, VOICE_SETTINGS_REQUEST_TIMEOUT_MS);
  const abortFromParent = () => {
    requestController.abort();
  };

  if (signal?.aborted) {
    requestController.abort();
  } else {
    signal?.addEventListener('abort', abortFromParent, { once: true });
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...callBrowserCapabilityHeaders(callSessionId),
      },
      body:
        method === 'POST'
          ? JSON.stringify({
              callSessionId,
              requestedVoiceRoute,
            })
          : undefined,
      cache: 'no-store',
      signal: requestController.signal,
    });
  } catch (error) {
    if (timedOut) {
      throw new VoiceSettingsTimeoutError();
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortFromParent);
  }

  const payload = (await response.json().catch(() => ({}))) as VoiceSettingsResponse;
  if (!response.ok) {
    const issue = callIssueFromResponse(response.status, payload);
    throw new CallRequestError(
      {
        ...issue,
        message: getErrorMessage(payload, issue.message),
      },
      payload.retryable === true
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
  const [issue, setIssue] = useState<CallIssue | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
      setIssue(null);
      setNotice(null);
      return;
    }

    const controller = new AbortController();
    let retryTimeoutId: ReturnType<typeof setTimeout> | null = null;
    setIsLoading(true);
    setError(null);
    setIssue(null);
    setNotice(null);
    setAssistantRoute(null);

    const loadVoiceSettings = (attempt: number) => {
      requestVoiceSettings('GET', callSessionId, undefined, controller.signal)
        .then((payload) => {
          setRequestedVoiceRouteState(payload.requestedVoiceRoute);
          setSavedVoiceRoute(payload.savedVoiceRoute);
          setSelectionVoiceRoute(normalizeSelectionRoute(payload.selectionVoiceRoute));
          setAssistantRoute(payload.assistantRoute);
          setError(null);
          setIssue(null);
        })
        .catch((nextError) => {
          if (isAbortError(nextError)) {
            return;
          }
          const shouldRetry =
            isTransientVoiceSettingsLoadError(nextError) && attempt + 1 < INITIAL_LOAD_MAX_ATTEMPTS;
          setError(
            formatVoiceSettingsError(nextError, 'Unable to load voice settings.', shouldRetry)
          );
          setIssue(
            nextError instanceof CallRequestError
              ? { kind: nextError.code, message: nextError.message }
              : nextError instanceof TypeError
                ? {
                    kind: 'gateway_down',
                    message: formatVoiceSettingsError(
                      nextError,
                      'Unable to load voice settings.',
                      shouldRetry
                    ),
                  }
                : {
                    kind: 'unknown',
                    message: formatVoiceSettingsError(nextError, 'Unable to load voice settings.'),
                  }
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

  const configuredVoiceRoute = useMemo<VoiceRouteState>(
    () => ({
      stt: requestedVoiceRoute.stt.provider ? requestedVoiceRoute.stt : savedVoiceRoute.stt,
      tts: requestedVoiceRoute.tts.provider ? requestedVoiceRoute.tts : savedVoiceRoute.tts,
    }),
    [requestedVoiceRoute, savedVoiceRoute]
  );

  const routeIssue = useMemo<CallIssue | null>(() => {
    if (!callSessionId || isLoading || issue) {
      return null;
    }
    if (!configuredVoiceRoute.stt.provider || !configuredVoiceRoute.tts.provider) {
      return {
        kind: 'no_route',
        message: 'This call has no complete speech and voice route configured.',
      };
    }
    if (!normalizedSelectionVoiceRoute) {
      return {
        kind: 'gateway_down',
        message: 'Viventium could not validate the configured voice route.',
      };
    }
    for (const modality of ['stt', 'tts'] as const) {
      const selection = configuredVoiceRoute[modality];
      const capability = normalizedSelectionVoiceRoute.capabilities.find(
        (candidate) =>
          candidate.modality === modality &&
          normalizeProviderName(candidate.id) === normalizeProviderName(selection.provider)
      );
      const variantMissing =
        Boolean(selection.variant) &&
        Boolean(capability?.variants.length) &&
        !capability?.variants.some((variant) => variant.id === selection.variant);
      if (!capability || !capability.available || variantMissing) {
        return {
          kind: 'provider_failure',
          message: `The configured ${modality === 'stt' ? 'speech recognition' : 'voice'} route is unavailable.`,
        };
      }
    }
    return null;
  }, [callSessionId, configuredVoiceRoute, isLoading, issue, normalizedSelectionVoiceRoute]);

  const setRequestedVoiceRoute = useCallback(
    async (nextRoute: VoiceRouteState) => {
      const normalizedRoute = normalizeVoiceRouteState(nextRoute);
      setNotice(null);
      setRequestedVoiceRouteState(normalizedRoute);

      if (!callSessionId) {
        return true;
      }

      setIsSaving(true);
      setError(null);
      setIssue(null);
      try {
        const payload = await requestVoiceSettings('POST', callSessionId, normalizedRoute);
        setRequestedVoiceRouteState(payload.requestedVoiceRoute);
        setSavedVoiceRoute(payload.savedVoiceRoute);
        setSelectionVoiceRoute(normalizeSelectionRoute(payload.selectionVoiceRoute));
        setAssistantRoute(payload.assistantRoute);
        return true;
      } catch (nextError) {
        const message = formatVoiceSettingsError(nextError, 'Unable to save voice settings.');
        setError(message);
        setIssue(
          nextError instanceof CallRequestError
            ? { kind: nextError.code, message: nextError.message }
            : nextError instanceof TypeError
              ? { kind: 'gateway_down', message }
              : { kind: 'unknown', message }
        );
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
    configuredVoiceRoute,
    selectionVoiceRoute: normalizedSelectionVoiceRoute,
    assistantRoute,
    isLoading,
    isSaving,
    error: error ?? routeIssue?.message ?? null,
    issue: issue ?? routeIssue,
    notice,
    setRequestedVoiceRoute,
  };
}
