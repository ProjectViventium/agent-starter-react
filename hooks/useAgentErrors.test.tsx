/* VIVENTIUM START
 * Purpose: Handle one terminal agent failure once while preserving later recovery failures.
 * VIVENTIUM END */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, renderHook, screen } from '@testing-library/react';
import { useAgentErrors } from '@/hooks/useAgentErrors';

const state = vi.hoisted(() => ({
  agent: { state: 'listening', failureReasons: [] as string[] },
  isConnected: true,
  end: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@livekit/components-react', () => ({
  useAgent: () => state.agent,
  useSessionContext: () => ({ isConnected: state.isConnected, end: state.end }),
}));
vi.mock('@/components/livekit/alert-toast', () => ({ toastAlert: state.toast }));

beforeEach(() => {
  vi.stubGlobal('React', React);
  state.agent = { state: 'listening', failureReasons: [] };
  state.isConnected = true;
  state.end = vi.fn().mockResolvedValue(undefined);
  state.toast.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('agent failure transition', () => {
  it('shows one toast and ends once when the same failed agent object is replaced', () => {
    state.agent = { state: 'failed', failureReasons: ['Agent left the room unexpectedly.'] };
    const { rerender } = renderHook(() => useAgentErrors());
    state.agent = { ...state.agent, failureReasons: [...state.agent.failureReasons] };
    rerender();
    expect(state.toast).toHaveBeenCalledTimes(1);
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Session ended' }));
    expect(state.end).toHaveBeenCalledTimes(1);
    render(state.toast.mock.calls[0][0].description);
    expect(screen.getByText('Agent left the room unexpectedly.')).toBeInTheDocument();
  });

  it('does not repeat teardown when the hook receives a new end callback during one failure', () => {
    state.agent = { state: 'failed', failureReasons: ['Synthetic terminal failure.'] };
    const firstEnd = state.end;
    const { rerender } = renderHook(() => useAgentErrors());
    state.end = vi.fn().mockResolvedValue(undefined);
    state.agent = { ...state.agent };
    rerender();
    expect(state.toast).toHaveBeenCalledTimes(1);
    expect(firstEnd).toHaveBeenCalledTimes(1);
    expect(state.end).not.toHaveBeenCalled();
  });

  it('has no effects while disconnected and handles the failure if it becomes connected', () => {
    state.agent = { state: 'failed', failureReasons: ['Synthetic terminal failure.'] };
    state.isConnected = false;
    const { rerender } = renderHook(() => useAgentErrors());
    state.agent = { ...state.agent };
    rerender();
    expect(state.toast).not.toHaveBeenCalled();
    expect(state.end).not.toHaveBeenCalled();
    state.isConnected = true;
    rerender();
    expect(state.toast).toHaveBeenCalledTimes(1);
    expect(state.end).toHaveBeenCalledTimes(1);
  });

  it('does not repeat a handled failure across disconnection with stale failed metadata', () => {
    state.agent = { state: 'failed', failureReasons: ['Synthetic terminal failure.'] };
    const { rerender } = renderHook(() => useAgentErrors());
    state.isConnected = false;
    rerender();
    state.isConnected = true;
    state.agent = { ...state.agent };
    rerender();
    expect(state.toast).toHaveBeenCalledTimes(1);
    expect(state.end).toHaveBeenCalledTimes(1);
  });

  it('handles a distinct later failure after a healthy reconnect and preserves all details', () => {
    state.agent = { state: 'failed', failureReasons: ['First terminal failure.'] };
    const firstEnd = state.end;
    const { rerender } = renderHook(() => useAgentErrors());
    state.isConnected = false;
    state.agent = { state: 'disconnected', failureReasons: [] };
    rerender();
    state.isConnected = true;
    state.agent = { state: 'listening', failureReasons: [] };
    state.end = vi.fn().mockResolvedValue(undefined);
    rerender();
    expect(state.toast).toHaveBeenCalledTimes(1);
    expect(firstEnd).toHaveBeenCalledTimes(1);
    expect(state.end).not.toHaveBeenCalled();
    state.agent = {
      state: 'failed',
      failureReasons: ['Later terminal failure.', 'Provider stopped.'],
    };
    rerender();
    expect(state.toast).toHaveBeenCalledTimes(2);
    expect(firstEnd).toHaveBeenCalledTimes(1);
    expect(state.end).toHaveBeenCalledTimes(1);
    render(state.toast.mock.calls[1][0].description);
    expect(screen.getByText('Later terminal failure.')).toBeInTheDocument();
    expect(screen.getByText('Provider stopped.')).toBeInTheDocument();
  });

  it('keeps healthy rerenders free of failure effects', () => {
    const { rerender } = renderHook(() => useAgentErrors());
    state.agent = { ...state.agent };
    state.end = vi.fn();
    rerender();
    expect(state.toast).not.toHaveBeenCalled();
    expect(state.end).not.toHaveBeenCalled();
  });

  it('handles a failed mount once in React Strict Mode', () => {
    state.agent = { state: 'failed', failureReasons: ['Synthetic terminal failure.'] };
    renderHook(() => useAgentErrors(), {
      wrapper: ({ children }) => <React.StrictMode>{children}</React.StrictMode>,
    });
    expect(state.toast).toHaveBeenCalledTimes(1);
    expect(state.end).toHaveBeenCalledTimes(1);
  });
});

/* VIVENTIUM START: Terminal startup ownership ends before the SDK teardown side effect. */
it('signals terminal startup once before ending the installed session', () => {
  const order: string[] = [];
  const failed = vi.fn(() => {
    order.push('terminal');
  });
  state.agent = { state: 'failed', failureReasons: ['Synthetic failure.'] };
  state.end.mockImplementation(async () => {
    order.push('end');
  });
  const { rerender } = renderHook(() => useAgentErrors(failed));
  rerender();
  expect(order).toEqual(['terminal', 'end']);
  expect(failed).toHaveBeenCalledOnce();
});
/* VIVENTIUM END */
