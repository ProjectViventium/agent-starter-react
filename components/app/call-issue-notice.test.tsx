import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CallIssueNotice } from '@/components/app/call-issue-notice';
import { WelcomeView } from '@/components/app/welcome-view';
import type { CallIssueKind } from '@/lib/call-start';

describe('CallIssueNotice', () => {
  it.each([
    ['auth_expired', 'This call link has expired'],
    ['mic_denied', 'Microphone access is blocked'],
    ['no_route', 'Voice is not configured'],
    ['gateway_down', 'The voice runtime is unavailable'],
    ['provider_failure', 'The configured voice provider is unavailable'],
  ] satisfies Array<[CallIssueKind, string]>)('renders distinct %s recovery copy', (kind, text) => {
    render(<CallIssueNotice issue={{ kind, message: 'raw internal message' }} onRetry={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent(text);
  });

  it('offers one inline retry for blocked microphone permission', () => {
    const onRetry = vi.fn();
    render(
      <CallIssueNotice
        issue={{ kind: 'mic_denied', message: 'Permission denied' }}
        onRetry={onRetry}
      />
    );
    expect(screen.getAllByRole('button')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Try microphone again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('offers one inline recovery for a retryable structured startup failure', () => {
    const onRetry = vi.fn();
    render(
      <CallIssueNotice
        issue={{ kind: 'gateway_down', message: 'Startup timed out.', retryable: true }}
        onRetry={onRetry}
      />
    );

    expect(screen.getAllByRole('button')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry recovery' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('does not mislabel a durable ended call as an expired launch after refresh', () => {
    render(
      <WelcomeView
        startButtonText="Call ended"
        onStartCall={vi.fn()}
        startDisabled
        callEnded
        callIssue={{ kind: 'auth_expired', message: 'The launch cannot be reused.' }}
      />
    );

    expect(screen.getByRole('status', { name: 'Call status: ended' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
