import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CallActivity } from '@/components/app/call-activity';
import type { VoiceTaskView } from '@/lib/voice-events';
import { CallResultFiles } from './call-result-files';

function task(changed: Partial<VoiceTaskView> = {}): VoiceTaskView {
  return {
    version: 1,
    eventId: 'event',
    sequence: 1,
    emittedAt: '2026-01-01T00:00:00Z',
    firstEmittedAt: '2026-01-01T00:00:00Z',
    callSessionId: 'call',
    conversationId: 'chat',
    taskId: 'task',
    state: 'completed',
    type: 'snapshot',
    resultMessageId: 'reply',
    cancellable: false,
    retryable: false,
    sources: [],
    ...changed,
  };
}
const payload = (changed = {}) => ({
  version: 1,
  event: task(),
  resultFilenames: ['report.csv'],
  ...changed,
});
let request: ReturnType<typeof vi.fn>;
let debug: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  window.sessionStorage.setItem('viventium.call.capability.v1:call', 'a'.repeat(43));
  window.sessionStorage.setItem(
    'viventium.call.opener-origin.v1:call',
    'https://chat.example.test'
  );
  request = vi.fn().mockResolvedValue({ ok: true, json: async () => payload() });
  vi.stubGlobal('fetch', request);
});
afterEach(() => {
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('completed call file result', () => {
  it('traces structural read stages without capability, URLs, names or owner content', async () => {
    request.mockResolvedValue({ ok: true, status: 200, json: async () => payload() });
    render(<CallResultFiles callSessionId="call" tasks={[task()]} />);
    await screen.findByText('report.csv');
    const traces = debug.mock.calls.map(([, trace]) => JSON.parse(String(trace)));
    expect(traces).toEqual([
      { stage: 'fetch_started', expectedSequence: 1 },
      { stage: 'http_response', expectedSequence: 1, httpStatus: 200 },
      {
        stage: 'validation', expectedSequence: 1, httpStatus: 200, reason: 'valid',
        returnedSequence: 1, returnedNameCount: 1,
      },
      { stage: 'accepted', expectedSequence: 1, returnedSequence: 1, acceptedCount: 1 },
    ]);
    const serialized = JSON.stringify([...debug.mock.calls, ...warn.mock.calls]);
    for (const privateValue of ['report.csv', 'https://', 'a'.repeat(43), 'callSessionId', 'taskId', 'resultMessageId']) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports a failed HTTP read without retrying or logging its body', async () => {
    request.mockResolvedValue({ ok: false, status: 403 });
    render(<CallResultFiles callSessionId="call" tasks={[task()]} />);
    await waitFor(() => expect(warn).toHaveBeenCalledWith('[ViventiumCallFiles]', JSON.stringify({
      stage: 'validation', expectedSequence: 1, httpStatus: 403, reason: 'http_error',
    })));
    expect(request).toHaveBeenCalledOnce();
    expect(screen.queryByText('report.csv')).not.toBeInTheDocument();
  });

  it('reports the rejected stale revision and never accepts the stale names', async () => {
    request.mockResolvedValue({ ok: true, status: 200, json: async () => payload() });
    render(<CallResultFiles callSessionId="call" tasks={[task({ sequence: 2 })]} />);
    await waitFor(() => expect(warn).toHaveBeenCalledWith('[ViventiumCallFiles]', JSON.stringify({
      stage: 'validation', expectedSequence: 2, httpStatus: 200, reason: 'stale_sequence',
      returnedSequence: 1, returnedNameCount: 1,
    })));
    expect(debug.mock.calls.some(([, trace]) =>
      JSON.parse(String(trace)).stage === 'accepted'
    )).toBe(false);
  });

  it('reports missing filename data as a contract failure rather than an empty result', async () => {
    request.mockResolvedValue({ ok: true, status: 200, json: async () => ({ version: 1, event: task() }) });
    render(<CallResultFiles callSessionId="call" tasks={[task()]} />);
    await waitFor(() => expect(warn).toHaveBeenCalledWith('[ViventiumCallFiles]', JSON.stringify({
      stage: 'validation', expectedSequence: 1, httpStatus: 200, reason: 'missing_filenames',
      returnedSequence: 1, returnedNameCount: undefined,
    })));
    expect(screen.queryByText('report.csv')).not.toBeInTheDocument();
  });

  it('reports a read exception without its private error text', async () => {
    request.mockRejectedValue(new Error('private network text and credential'));
    render(<CallResultFiles callSessionId="call" tasks={[task()]} />);
    await waitFor(() => expect(warn).toHaveBeenCalledWith('[ViventiumCallFiles]', JSON.stringify({
      stage: 'read_failed', expectedSequence: 1, reason: 'read_failed',
    })));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private network text');
    expect(request).toHaveBeenCalledOnce();
  });

  it('loads once per task revision with current capability and opens the canonical authenticated chat', async () => {
    const { rerender } = render(<CallResultFiles callSessionId="call" tasks={[task()]} />);
    await screen.findByText('report.csv');
    expect(request).toHaveBeenCalledWith(
      '/api/call-tasks/task?callSessionId=call',
      expect.objectContaining({
        cache: 'no-store',
        headers: { 'X-VIVENTIUM-CALL-CAPABILITY': 'a'.repeat(43) },
      })
    );
    const link = screen.getByRole('link', { name: 'Open in chat' });
    expect(link).toHaveAttribute('href', 'https://chat.example.test/c/chat');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    rerender(<CallResultFiles callSessionId="call" tasks={[task({ sequence: 2 })]} />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss files' }));
    expect(screen.queryByText('report.csv')).not.toBeInTheDocument();
  });
  it('refreshes the early unfinished miss on a committed snapshot revision without polling', async () => {
    request.mockResolvedValueOnce({ ok: true, json: async () => payload({ resultFilenames: [] }) });
    const { rerender } = render(<CallResultFiles callSessionId="call" tasks={[task()]} />);
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(screen.queryByRole('region', { name: 'Files from this reply' })).not.toBeInTheDocument();
    request.mockResolvedValue({ ok: true, json: async () => payload({ event: task({ sequence: 2, type: 'snapshot' }) }) });
    rerender(<CallResultFiles callSessionId="call" tasks={[task({ sequence: 2, type: 'snapshot' })]} />);
    await screen.findByText('report.csv');
    expect(request).toHaveBeenCalledTimes(2);
    rerender(<CallResultFiles callSessionId="call" tasks={[task({ sequence: 2, type: 'snapshot' })]} />);
    expect(request).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss files' }));
    request.mockResolvedValue({ ok: true, json: async () => payload({ event: task({ sequence: 3 }) }) });
    rerender(<CallResultFiles callSessionId="call" tasks={[task({ sequence: 3 })]} />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    expect(screen.queryByText('report.csv')).not.toBeInTheDocument();
  });
  it('ignores a stale result read revision', async () => {
    render(<CallResultFiles callSessionId="call" tasks={[task({ sequence: 2 })]} />);
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(screen.queryByText('report.csv')).not.toBeInTheDocument();
  });
  it('remains usable after the existing status activity hides at eight seconds' , async () => {
    vi.useFakeTimers();
    const tasks = [task()];
    render(
      <>
        <CallActivity tasks={tasks} />
        <CallResultFiles callSessionId="call" tasks={tasks} />
      </>
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText('report.csv')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Call activity' })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(8_000));
    expect(screen.queryByRole('region', { name: 'Call activity' })).not.toBeInTheDocument();
    expect(screen.getByText('report.csv')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in chat' })).toBeInTheDocument();
  });
  it.each([
    ['running', task({ state: 'running' })],
    ['failed', task({ state: 'failed' })],
    ['no result ID', task({ resultMessageId: undefined })],
    ['foreign call', task({ callSessionId: 'foreign' })],
  ])('%s does not request files', (_name, value) => {
    render(<CallResultFiles callSessionId="call" tasks={[value]} />);
    expect(request).not.toHaveBeenCalled();
  });
  it('does not extend a missing or cleared call capability', () => {
    window.sessionStorage.clear();
    render(<CallResultFiles callSessionId="call" tasks={[task()]} />);
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    ['missing files', payload({ resultFilenames: [] })],
    ['wrong result ID', payload({ event: task({ resultMessageId: 'foreign' }) })],
    ['wrong conversation', payload({ event: task({ conversationId: 'foreign' }) })],
    ['wrong call', payload({ event: task({ callSessionId: 'foreign' }) })],
    ['wrong task', payload({ event: task({ taskId: 'foreign' }) })],
    ['failed task', payload({ event: task({ state: 'failed' }) })],
    ['malformed filename', payload({ resultFilenames: [{ filepath: '/private/unused' }] })],
    ['missing filename data', { version: 1, event: task() }],
  ])('%s renders no false file card', async (_name, response) => {
    request.mockResolvedValue({ ok: true, json: async () => response });
    render(<CallResultFiles callSessionId="call" tasks={[task()]} />);
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(screen.queryByRole('region', { name: 'Files from this reply' })).not.toBeInTheDocument();
  });
  it('failed authorization renders no file card and makes no retry', async () => {
    request.mockResolvedValue({ ok: false, status: 403 });
    render(<CallResultFiles callSessionId="call" tasks={[task()]} />);
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(screen.queryByText('report.csv')).not.toBeInTheDocument();
  });
  it('clears an already resolved old card when the conversation changes and the new read fails', async () => {
    const { rerender } = render(<CallResultFiles callSessionId="call" tasks={[task()]} />);
    await screen.findByText('report.csv');
    request.mockResolvedValue({ ok: false, status: 404 });
    rerender(
      <CallResultFiles callSessionId="call" tasks={[task({ conversationId: 'corrected' })]} />
    );
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('report.csv')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Files from this reply' })).not.toBeInTheDocument();
  });
  it('renders a hostile filename as plain text with only the canonical chat action', async () => {
    const name = '<img src=x onerror=alert(1)>';
    request.mockResolvedValue({ ok: true, json: async () => payload({ resultFilenames: [name] }) });
    const { container } = render(<CallResultFiles callSessionId="call" tasks={[task()]} />);
    await screen.findByText(name);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://chat.example.test/c/chat');
  });
  it('ignores an old result request after the task result changes', async () => {
    let resolveOld!: (value: {
      ok: boolean;
      json: () => Promise<ReturnType<typeof payload>>;
    }) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        })
    );
    const { rerender } = render(<CallResultFiles callSessionId="call" tasks={[task()]} />);
    request.mockResolvedValue({
      ok: true,
      json: async () =>
        payload({ event: task({ resultMessageId: 'new' }), resultFilenames: ['new.txt'] }),
    });
    rerender(<CallResultFiles callSessionId="call" tasks={[task({ resultMessageId: 'new' })]} />);
    await screen.findByText('new.txt');
    await act(async () => resolveOld({ ok: true, json: async () => payload() }));
    expect(screen.queryByText('report.csv')).not.toBeInTheDocument();
  });
});
