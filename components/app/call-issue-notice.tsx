'use client';

import React from 'react';
import { Button } from '@/components/livekit/button';
import type { CallIssue, CallIssueKind } from '@/lib/call-start';

const ISSUE_COPY: Record<CallIssueKind, { title: string; detail: string }> = {
  auth_expired: {
    title: 'This call link has expired',
    detail: 'Start a fresh call from your Viventium conversation.',
  },
  mic_denied: {
    title: 'Microphone access is blocked',
    detail: 'Allow microphone access for this site, then try once more.',
  },
  microphone_missing: {
    title: 'No microphone is available',
    detail: 'Connect or enable a microphone to continue.',
  },
  no_route: {
    title: 'Voice is not configured',
    detail: 'Viventium kept your configured route and did not switch providers automatically.',
  },
  gateway_down: {
    title: 'The voice runtime is unavailable',
    detail: 'Viventium will keep the failure distinct from microphone permission problems.',
  },
  provider_failure: {
    title: 'The configured voice provider is unavailable',
    detail: 'Your configured provider was preserved. Viventium did not send audio elsewhere.',
  },
  unknown: {
    title: 'The call could not start',
    detail: 'Your conversation is safe. Try the call again from Viventium.',
  },
};

export function CallIssueNotice({
  issue,
  onRetry,
  showRetry = false,
}: {
  issue: CallIssue;
  onRetry?: () => void;
  showRetry?: boolean;
}) {
  const copy = ISSUE_COPY[issue.kind];
  return (
    <div
      role="alert"
      className="border-destructive/30 bg-destructive/5 rounded-xl border p-3 text-left"
    >
      <p className="text-sm font-semibold">{copy.title}</p>
      <p className="text-muted-foreground mt-1 text-xs leading-5">{copy.detail}</p>
      {(issue.kind === 'mic_denied' || issue.retryable === true || showRetry) && onRetry ? (
        <Button type="button" size="sm" variant="outline" className="mt-3" onClick={onRetry}>
          {issue.kind === 'mic_denied' ? 'Try microphone again' : 'Retry recovery'}
        </Button>
      ) : null}
    </div>
  );
}
