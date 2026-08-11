import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  type AccessibleCallStatus,
  CallModeControl,
  CallStatusIndicator,
  LISTEN_ONLY_PRECONNECT_MESSAGE,
} from '@/components/app/call-mode-control';

describe('CallModeControl', () => {
  it('does not promise durable memory in Listen-Only copy', () => {
    expect(LISTEN_ONLY_PRECONNECT_MESSAGE).toBe('Viventium is here with you, just listening.');
    expect(LISTEN_ONLY_PRECONNECT_MESSAGE).not.toContain('remember');
  });

  it('switches Call, Wing, and Listen-Only with one atomic choice', () => {
    const onModeChange = vi.fn();
    render(<CallModeControl mode="call" pending={false} onModeChange={onModeChange} />);

    expect(screen.getByRole('button', { name: 'Call' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Wing' }));
    fireEvent.click(screen.getByRole('button', { name: 'Listen-Only' }));
    expect(onModeChange.mock.calls).toEqual([['wing'], ['listen_only']]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('disables all choices during a single atomic update', () => {
    render(<CallModeControl mode="wing" pending onModeChange={vi.fn()} />);
    expect(screen.getAllByRole('button').every((button) => button.hasAttribute('disabled'))).toBe(
      true
    );
  });

  it('disables mode and status transitions when reduced motion is requested', () => {
    render(
      <>
        <CallModeControl mode="call" pending={false} onModeChange={vi.fn()} />
        <CallStatusIndicator status="connecting" mode="call" />
      </>
    );
    expect(screen.getByRole('button', { name: 'Call' })).toHaveClass(
      'motion-reduce:transition-none'
    );
    expect(screen.getByTestId('call-status-dot')).toHaveClass('motion-reduce:transition-none');
  });
});

describe('CallStatusIndicator', () => {
  it.each([
    'connecting',
    'listening',
    'speaking',
    'working',
    'needs input',
    'degraded',
    'failed',
    'ended',
  ] satisfies AccessibleCallStatus[])('announces %s accessibly', (status) => {
    render(<CallStatusIndicator status={status} mode="listen_only" />);
    expect(screen.getByRole('status')).toHaveTextContent(status);
    expect(screen.getByRole('status')).toHaveAccessibleName(`Call status: ${status}`);
  });
});
