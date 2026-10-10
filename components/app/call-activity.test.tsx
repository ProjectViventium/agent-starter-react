import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import {
  CallActivity,
  LatestSpeakerCaption,
  SpeakerTranscript,
} from '@/components/app/call-activity';
import {
  type SpeakerSegmentV1,
  type VoiceTaskEventV1,
  type VoiceTaskView,
  applyTaskEvent,
  parseTaskEvent,
} from '@/lib/voice-events';

function task(overrides: Partial<VoiceTaskEventV1> = {}): VoiceTaskEventV1 {
  return {
    version: 1,
    eventId: 'event-1',
    sequence: 1,
    emittedAt: '2026-08-09T12:00:00.000Z',
    callSessionId: 'call-1',
    taskId: 'task-1',
    type: 'progress',
    state: 'running',
    phase: 'Searching trusted sources',
    label: 'Market lookup',
    progress: { current: 2, total: 4, unit: 'sources' },
    source: { title: 'Primary documentation', url: 'https://example.com/docs' },
    cancellable: true,
    retryable: false,
    ...overrides,
  };
}

function view(overrides: Partial<VoiceTaskEventV1> = {}): VoiceTaskView {
  const event = task(overrides);
  return {
    ...event,
    firstEmittedAt: event.emittedAt,
    sources: event.source ? [event.source] : [],
  };
}

function segment(overrides: Partial<SpeakerSegmentV1> = {}): SpeakerSegmentV1 {
  return {
    version: 1,
    segmentId: 'segment-1',
    callSessionId: 'call-1',
    turnId: 'turn-1',
    sequence: 1,
    revision: 2,
    text: 'We should ship this carefully.',
    isFinal: true,
    speaker: {
      key: 'speaker-1',
      label: 'Speaker 1',
      source: 'provider_diarization',
      attribution: 'unverified',
      actorTrust: 'shared_mic_unverified',
    },
    ...overrides,
  };
}

describe('CallActivity', () => {
  it('retains an unconfirmed Stop until Dismiss without claiming cancellation or offering replay', () => {
    vi.useFakeTimers();
    try {
      render(
        <CallActivity
          tasks={[
            view({
              state: 'cancelled_unenforceable',
              type: 'state',
              phase: 'cancelled_unenforceable',
              label: 'Cancellation could not be confirmed',
              detail: 'Late output remains suppressed.',
              cancellable: false,
              retryable: false,
              error: undefined,
            }),
          ]}
          onCancel={vi.fn()}
          onRetry={vi.fn()}
        />
      );
      act(() => vi.advanceTimersByTime(20_001));
      expect(screen.getByText('Stop not confirmed', { exact: true })).toBeVisible();
      expect(screen.getByText('Late output remains suppressed.')).toBeVisible();
      expect(screen.queryByText('Stopped', { exact: true })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Cancel / })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Retry / })).not.toBeInTheDocument();
      fireEvent.click(
        screen.getByRole('button', { name: 'Dismiss Cancellation could not be confirmed' })
      );
      expect(screen.queryByText('Stop not confirmed', { exact: true })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the Main label for Cancel while showing typed cortex activity in detail', () => {
    const cancel = vi.fn();
    const starting = view({ label: 'Writing reply', phase: 'tool', detail: 'Step started' });
    const next = parseTaskEvent(
      JSON.stringify(
        task({
          eventId: 'cortex-progress-next',
          sequence: starting.sequence + 1,
          type: 'progress',
          phase: 'cortex',
          label: 'Writing reply',
          detail: 'Synthetic recall: complete',
        })
      )
    )!;
    render(<CallActivity tasks={applyTaskEvent([starting], next)} onCancel={cancel} />);
    expect(screen.getByText('Writing reply', { exact: true })).toBeVisible();
    expect(screen.getByText('Synthetic recall: complete', { exact: true })).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Cancel Synthetic recall' })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Writing reply' }));
    expect(cancel).toHaveBeenCalledWith('task-1');
  });

  it('shows only authoritative work details and exposes cancel without visual clutter', () => {
    const onCancel = vi.fn();
    render(<CallActivity tasks={[view()]} onCancel={onCancel} onRetry={vi.fn()} />);

    expect(screen.getByRole('status')).toHaveTextContent('Market lookup');
    expect(screen.getByRole('status')).toHaveTextContent('Searching trusted sources');
    expect(screen.getByRole('status')).toHaveTextContent('2 of 4 sources');
    expect(screen.getByRole('link', { name: 'Primary documentation' })).toHaveAttribute(
      'href',
      'https://example.com/docs'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Market lookup' }));
    expect(onCancel).toHaveBeenCalledWith('task-1');
  });

  it('renders needs-input and retry only when authoritative state allows them', () => {
    const onRetry = vi.fn();
    render(
      <CallActivity
        tasks={[
          view({
            state: 'needs_input',
            type: 'needs_input',
            needsInput: {
              prompt: 'Which report should I use?',
              inputType: 'text',
            },
            cancellable: false,
          }),
          view({
            eventId: 'event-2',
            taskId: 'task-2',
            sequence: 2,
            state: 'failed',
            type: 'error',
            label: 'Second task',
            retryable: true,
            cancellable: false,
          }),
        ]}
        onCancel={vi.fn()}
        onRetry={onRetry}
      />
    );
    expect(screen.getByText('Which report should I use?')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Retry Second task' }));
    expect(onRetry).toHaveBeenCalledWith('task-2');
  });

  it('renders hostile source URLs as non-clickable text', () => {
    render(
      <CallActivity
        tasks={[
          view({
            source: { title: 'Unsafe source', url: 'javascript:alert(1)' },
          }),
        ]}
      />
    );
    expect(screen.getByText('Unsafe source')).not.toHaveAttribute('href');
    expect(screen.queryByRole('link', { name: 'Unsafe source' })).not.toBeInTheDocument();
  });

  it('retains and renders multiple authoritative sources', () => {
    const first = {
      id: 'one',
      title: 'First source',
      url: 'https://one.example',
    };
    const second = {
      id: 'two',
      title: 'Second source',
      url: 'https://two.example',
    };
    render(<CallActivity tasks={[{ ...view({ source: second }), sources: [first, second] }]} />);
    expect(screen.getByRole('link', { name: 'First source' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Second source' })).toBeVisible();
  });

  it('renders reconnect source history once while retaining a distinct late Cortex child', () => {
    const consoleError = vi.spyOn(console, 'error');
    try {
      const source = { id: 'cortex-child-a', title: 'Background follow-up' };
      const snapshot = parseTaskEvent(
        task({
          eventId: 'reconnect-snapshot',
          type: 'snapshot',
          state: 'completed',
          phase: 'follow_up',
          label: 'Follow-up ready',
          source,
          sources: [source],
          resultMessageId: 'main-result',
          presentation: { ref: source.id, state: 'interrupted', startedAtMs: 1234 },
        })
      )!;
      let tasks = applyTaskEvent([], snapshot);
      const { rerender } = render(<CallActivity tasks={tasks} />);
      const sources = screen.getByRole('list', { name: 'Sources for Follow-up ready' });
      expect(within(sources).getAllByRole('listitem')).toHaveLength(1);

      const second = { ...source, id: 'cortex-child-b' };
      const next = task({
        eventId: 'late-child-2',
        sequence: 2,
        state: 'completed',
        phase: 'follow_up',
        label: 'Follow-up ready',
        source: second,
        resultMessageId: 'main-result',
      });
      tasks = applyTaskEvent(tasks, next);
      rerender(<CallActivity tasks={tasks} />);
      expect(within(sources).getAllByRole('listitem')).toHaveLength(2);
      expect(within(sources).getAllByText('Background follow-up')).toHaveLength(2);

      tasks = applyTaskEvent(tasks, {
        ...next,
        type: 'snapshot',
        eventId: 'equal-reconnect-snapshot',
        sources: [source, second],
      });
      rerender(<CallActivity tasks={tasks} />);
      expect(within(sources).getAllByRole('listitem')).toHaveLength(2);
      expect(tasks[0]?.resultMessageId).toBe('main-result');
      expect(tasks[0]?.presentation).toEqual(snapshot.presentation);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('briefly shows terminal state and then dismisses the compact card', () => {
    vi.useFakeTimers();
    render(<CallActivity tasks={[view({ state: 'completed', type: 'result' })]} />);
    expect(screen.getByText('Done')).toBeVisible();
    act(() => vi.advanceTimersByTime(8_001));
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('keeps a completed file-delivery error visible without offering replay', () => {
    vi.useFakeTimers();
    render(
      <CallActivity
        tasks={[
          view({
            state: 'completed',
            type: 'result',
            phase: 'completed',
            label: 'Completed',
            resultMessageId: 'reply-delivery',
            cancellable: false,
            retryable: false,
            error: {
              code: 'native_output_file_unavailable',
              message: 'The file could not be attached.',
            },
          }),
        ]}
        onRetry={vi.fn()}
      />
    );
    expect(screen.getByRole('alert')).toHaveTextContent('The file could not be attached.');
    expect(screen.queryByRole('button', { name: 'Retry Completed' })).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(20_001));
    expect(screen.getByRole('alert')).toHaveTextContent('The file could not be attached.');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Completed' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('shows the authoritative error after an input request settles as failed', () => {
    let tasks = applyTaskEvent(
      [],
      task({
        state: 'needs_input',
        type: 'needs_input',
        phase: 'needs_input',
        needsInput: { prompt: 'Allow this action?', inputType: 'confirm' },
      })
    );
    tasks = applyTaskEvent(
      tasks,
      task({
        eventId: 'continuing',
        sequence: 2,
        state: 'running',
        phase: 'running',
      })
    );
    tasks = applyTaskEvent(
      tasks,
      task({
        eventId: 'declined',
        sequence: 3,
        state: 'failed',
        type: 'error',
        phase: 'failed',
        cancellable: false,
        error: {
          code: 'native_input_declined',
          message: 'You declined that action. It was stopped.',
        },
      })
    );
    render(<CallActivity tasks={tasks} onInput={vi.fn()} />);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'You declined that action. It was stopped.'
    );
    expect(screen.queryByText('Allow this action?')).not.toBeInTheDocument();
  });

  it('retains terminal errors until explicit dismissal, while completed tasks still expire', () => {
    vi.useFakeTimers();
    render(
      <CallActivity
        tasks={[
          view({
            state: 'failed',
            type: 'error',
            phase: 'failed',
            label: 'Stopped action',
            cancellable: false,
            error: {
              code: 'action_rejected',
              message: 'The action was stopped.',
            },
          }),
          view({
            eventId: 'done',
            taskId: 'task-2',
            state: 'completed',
            type: 'result',
          }),
        ]}
      />
    );
    act(() => vi.advanceTimersByTime(20_001));
    expect(screen.getByText('Stopped action')).toBeVisible();
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Stopped action' }));
    expect(screen.queryByText('Stopped action')).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('keeps cancel but suppresses retry and new-work input in Listen-Only', () => {
    render(
      <CallActivity
        mode="listen_only"
        tasks={[
          view({
            state: 'needs_input',
            type: 'needs_input',
            needsInput: { prompt: 'Should I continue?', inputType: 'confirm' },
            cancellable: true,
            retryable: true,
          }),
        ]}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onInput={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Cancel Market lookup' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Retry Market lookup' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('does not put interactive task controls inside a status live region', () => {
    render(<CallActivity tasks={[view()]} onCancel={vi.fn()} />);
    const cancel = screen.getByRole('button', { name: 'Cancel Market lookup' });
    expect(cancel.closest('[role="status"]')).toBeNull();
    expect(screen.getByRole('status', { name: 'Call activity update' })).toBeVisible();
  });
});

describe('SpeakerTranscript', () => {
  it('renders call-scoped speaker labels, revisions, overlap, and Unknown abstention', () => {
    render(
      <SpeakerTranscript
        segments={[
          segment(),
          segment({
            segmentId: 'segment-2',
            sequence: 2,
            revision: 0,
            uncertain: true,
            overlap: true,
            text: 'I could not attribute this safely.',
            speaker: {
              key: 'unknown',
              label: 'Unknown',
              source: 'unknown',
              attribution: 'unknown',
              actorTrust: 'unknown',
            },
          }),
        ]}
      />
    );

    expect(screen.getByText('Speaker 1')).toBeVisible();
    expect(screen.getByText('Unknown')).toBeVisible();
    expect(screen.getByText('Updated')).toBeVisible();
    expect(screen.getByText('Overlapping · uncertain')).toBeVisible();
  });

  it('updates the passive latest caption revision in place with truthful attribution', () => {
    const { rerender } = render(<LatestSpeakerCaption segments={[segment({ revision: 1 })]} />);
    const liveRegion = screen.getByRole('status');
    expect(liveRegion).toHaveTextContent('Speaker 1 · We should ship this carefully.');

    rerender(
      <LatestSpeakerCaption
        segments={[
          segment({
            revision: 2,
            text: 'Revised words.',
            overlap: true,
            uncertain: true,
          }),
        ]}
      />
    );
    expect(screen.getByRole('status')).toBe(liveRegion);
    expect(liveRegion).toHaveTextContent('Unknown · overlapping · Revised words.');
  });

  it('automatically windows more than four thousand segments while preserving full scroll access', () => {
    const segments = Array.from({ length: 4_096 }, (_, index) =>
      segment({
        segmentId: `segment-${index}`,
        turnId: `turn-${index}`,
        sequence: index,
        revision: 1,
        text: `Synthetic speaker segment ${index}`,
      })
    );
    const scrollContainerRef = React.createRef<HTMLDivElement>();
    render(
      <div ref={scrollContainerRef}>
        <SpeakerTranscript segments={segments} scrollContainerRef={scrollContainerRef} />
      </div>
    );

    const container = scrollContainerRef.current!;
    const transcript = screen.getByRole('list', { name: 'Speaker transcript' });
    const rect = (top: number, bottom: number) => ({
      top,
      bottom,
      left: 0,
      right: 500,
      width: 500,
      height: bottom - top,
      x: 0,
      y: top,
      toJSON: () => ({}),
    });
    vi.spyOn(container, 'getBoundingClientRect').mockImplementation(() => rect(0, 600));
    const transcriptRect = vi
      .spyOn(transcript, 'getBoundingClientRect')
      .mockImplementation(() => rect(20, 580));

    expect(screen.getByText('Synthetic speaker segment 4095')).toBeVisible();
    expect(screen.queryByText('Synthetic speaker segment 0')).not.toBeInTheDocument();
    expect(transcript.querySelectorAll('li')).toHaveLength(160);

    for (let index = 0; index < 34; index += 1) {
      fireEvent.scroll(container);
    }

    expect(screen.getByText('Synthetic speaker segment 0')).toBeVisible();
    expect(transcript.querySelectorAll('li').length).toBeLessThanOrEqual(512);
    expect(transcript.querySelector('li')).toHaveAttribute('aria-setsize', '4096');
    expect(transcript.querySelector('li')).toHaveAttribute('aria-posinset', '1');

    transcriptRect.mockImplementation(() => rect(-500, 580));
    for (let index = 0; index < 34; index += 1) {
      fireEvent.scroll(container);
    }

    expect(screen.getByText('Synthetic speaker segment 4095')).toBeVisible();
    expect(screen.queryByText('Synthetic speaker segment 0')).not.toBeInTheDocument();
    expect(transcript.querySelectorAll('li').length).toBeLessThanOrEqual(512);
  });
});

describe('Native action permission choices', () => {
  it('parses a long approval prompt, renders its full text, and submits exact choice identifiers', () => {
    const onInput = vi.fn();
    const prompt = `${'Synthetic action details. '.repeat(120)}\nFinal requested operation.`;
    expect(prompt.length).toBeGreaterThan(2_000);
    const event = parseTaskEvent(
      JSON.stringify(
        task({
          state: 'needs_input',
          type: 'needs_input',
          needsInput: {
            prompt,
            inputType: 'choice',
            choices: [
              { value: 'allow-a', label: 'Allow once' },
              { value: 'deny-a', label: 'Deny' },
            ],
          },
        })
      )
    );
    expect(event).not.toBeNull();
    render(<CallActivity tasks={applyTaskEvent([], event!)} onInput={onInput} />);
    expect(screen.getByText(prompt, { exact: true, normalizer: (text) => text })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(onInput).toHaveBeenCalledWith('task-1', 'allow-a');
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(onInput).toHaveBeenLastCalledWith('task-1', 'deny-a');
  });
});

describe('typed task phase presentation', () => {
  it('shows Starting once without exposing the internal phase code', () => {
    render(
      <CallActivity
        tasks={[
          view({
            type: 'state',
            phase: 'starting',
            label: 'Starting',
            progress: undefined,
          }),
        ]}
      />
    );
    expect(screen.getAllByText('Starting', { exact: true })).toHaveLength(1);
    expect(screen.queryByText('starting', { exact: true })).not.toBeInTheDocument();
  });
  it.each(['cortex', 'tool'])(
    'uses the typed task-state badge for the internal category %s while retaining progress',
    (phase) => {
      render(<CallActivity tasks={[view({ phase, label: 'Deep Memory Search' })]} />);
      expect(screen.queryByText(phase, { exact: true })).not.toBeInTheDocument();
      expect(screen.getAllByText('Working', { exact: true })).toHaveLength(1);
      expect(screen.getByRole('status')).toHaveTextContent('2 of 4 sources');
      expect(screen.getByRole('link', { name: 'Primary documentation' })).toBeInTheDocument();
    }
  );
  it('deduplicates an exact human heading and phase without dropping its numeric progress', () => {
    render(<CallActivity tasks={[view({ label: 'Searching trusted sources' })]} />);
    expect(screen.getAllByText('Searching trusted sources', { exact: true })).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('2 of 4 sources');
  });
  it('preserves a human phase containing an internal-category word and keeps Stop controls', () => {
    const onCancel = vi.fn();
    render(
      <CallActivity tasks={[view({ phase: 'Inspect cortex findings' })]} onCancel={onCancel} />
    );
    expect(screen.getByText('Inspect cortex findings', { exact: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Market lookup' }));
    expect(onCancel).toHaveBeenCalledWith('task-1');
  });
});

describe('declared phase presentation', () => {
  it.each([
    'cortex',
    'tool',
    'tool_completed',
    'delegated',
    'source',
    'follow_up',
    'agent',
    'owner_linked',
    'retried',
    'already_completed',
    'cancel_barrier_recovering',
  ])(
    'retains status, progress and human labels without exposing the internal phase %s',
    (phase) => {
      render(<CallActivity tasks={[view({ phase, label: 'Reading the document' })]} />);
      expect(screen.getByText('Reading the document')).toBeVisible();
      expect(screen.getByText('Working')).toBeVisible();
      expect(screen.getByRole('status')).toHaveTextContent('2 of 4 sources');
      expect(screen.queryByText(phase, { exact: true })).not.toBeInTheDocument();
    }
  );
});

describe('completed text with ongoing native speech', () => {
  it('keeps one exact active completed reply visible and stops only its presentation', () => {
    vi.useFakeTimers();
    try {
      const onCancel = vi.fn();
      const old = view({
        taskId: 'old',
        state: 'completed',
        cancellable: false,
        presentation: { ref: 'old-speech', state: 'speaking', startedAtMs: 1000 },
      });
      const current = view({
        taskId: 'current',
        label: 'Completed reply',
        state: 'completed',
        cancellable: false,
        resultMessageId: 'result-current',
        presentation: { ref: 'current-speech', state: 'speaking', startedAtMs: 2000 },
      });
      render(<CallActivity isAgentSpeaking tasks={[old, current]} onCancel={onCancel} />);
      act(() => vi.advanceTimersByTime(20_001));
      const stop = screen.getByRole('button', { name: 'Stop speech for Completed reply' });
      expect(stop).toBeVisible();
      expect(screen.getAllByRole('button', { name: /^Stop speech/ })).toHaveLength(1);
      fireEvent.click(stop);
      expect(onCancel).toHaveBeenCalledWith('current', 'current-speech');
      expect(screen.queryByRole('button', { name: /^Cancel/ })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
  it('terminal or superseded audio removes Stop and cannot revive a stale completed row', () => {
    const current = view({
      taskId: 'current',
      state: 'completed',
      cancellable: false,
      presentation: { ref: 'current-speech', state: 'interrupted', startedAtMs: 2000 },
    });
    const old = view({
      taskId: 'old',
      state: 'completed',
      cancellable: false,
      presentation: { ref: 'old-speech', state: 'speaking', startedAtMs: 1000 },
    });
    render(<CallActivity isAgentSpeaking tasks={[old, current]} onCancel={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /^Stop speech/ })).not.toBeInTheDocument();
  });
  it('completed history without an authenticated presentation never gets a Stop control', () => {
    render(
      <CallActivity
        isAgentSpeaking
        tasks={Array.from({ length: 10 }, (_, n) =>
          view({ taskId: `done-${n}`, state: 'completed', cancellable: false })
        )}
        onCancel={vi.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: /^Stop speech/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Cancel/ })).not.toBeInTheDocument();
  });
  it('generation Cancel remains unchanged while a completed Stop request is truthfully pending', () => {
    const onCancel = vi.fn();
    render(
      <CallActivity
        isAgentSpeaking
        tasks={[
          view({ taskId: 'working' }),
          view({
            taskId: 'done',
            state: 'completed',
            cancellable: false,
            presentation: { ref: 'speech-done', state: 'stop_requested', startedAtMs: 2000 },
          }),
        ]}
        onCancel={onCancel}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Market lookup' }));
    expect(onCancel).toHaveBeenCalledWith('working');
    expect(screen.getByText('Stopping speech', { exact: true })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /^Stop speech/ }));
    expect(onCancel).toHaveBeenCalledWith('done', 'speech-done');
  });
});

it('keeps active speech Stop available without a no-op Dismiss for a degraded completed result', () => {
  const completed = view({
    state: 'completed',
    cancellable: false,
    error: {
      code: 'native_output_file_unavailable',
      message: 'The requested file is unavailable.',
    },
    presentation: { ref: 'speech-1', state: 'speaking', startedAtMs: 1000 },
  });
  const { rerender } = render(
    <CallActivity isAgentSpeaking tasks={[completed]} onCancel={vi.fn()} />
  );
  expect(screen.getByRole('button', { name: /^Stop speech/ })).toBeVisible();
  expect(screen.queryByRole('button', { name: /^Dismiss/ })).not.toBeInTheDocument();
  rerender(
    <CallActivity
      isAgentSpeaking
      tasks={[
        {
          ...completed,
          presentation: { ref: 'speech-1', state: 'interrupted', startedAtMs: 1000 },
        },
      ]}
      onCancel={vi.fn()}
    />
  );
  expect(screen.queryByRole('button', { name: /^Stop speech/ })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^Dismiss/ })).toBeVisible();
});

it('hides restored or lost-terminal stale speech controls when the native agent is no longer speaking', () => {
  const completed = view({
    state: 'completed',
    cancellable: false,
    presentation: { ref: 'speech-1', state: 'speaking', startedAtMs: 1000 },
  });
  const { rerender } = render(
    <CallActivity isAgentSpeaking tasks={[completed]} onCancel={vi.fn()} />
  );
  expect(screen.getByRole('button', { name: /^Stop speech/ })).toBeVisible();
  rerender(<CallActivity isAgentSpeaking={false} tasks={[completed]} onCancel={vi.fn()} />);
  expect(screen.queryByRole('button', { name: /^Stop speech/ })).not.toBeInTheDocument();
  expect(screen.queryByText('Speaking', { exact: true })).not.toBeInTheDocument();
});

it('keeps the exact pending Stop row visible beyond terminal auto-hide until native terminal confirmation', () => {
  vi.useFakeTimers();
  try {
    const completed = view({
      label: 'Completed reply',
      state: 'completed',
      cancellable: false,
      resultMessageId: 'result-1',
      presentation: { ref: 'speech-1', state: 'stop_requested', startedAtMs: 1000 },
    });
    const { rerender } = render(
      <CallActivity isAgentSpeaking={false} tasks={[completed]} onCancel={vi.fn()} />
    );
    act(() => vi.advanceTimersByTime(20_001));
    expect(screen.getByText('Stopping speech', { exact: true })).toBeVisible();
    expect(screen.getByText('Completed reply')).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Dismiss/ })).not.toBeInTheDocument();
    rerender(
      <CallActivity
        isAgentSpeaking={false}
        tasks={[
          {
            ...completed,
            presentation: { ref: 'speech-1', state: 'interrupted', startedAtMs: 1000 },
          },
        ]}
        onCancel={vi.fn()}
      />
    );
    act(() => vi.advanceTimersByTime(8_001));
    expect(screen.queryByText('Completed reply')).not.toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

it('allows an exact idempotent speech Stop retry after the request ends while native speech continues', () => {
  const onCancel = vi.fn();
  const completed = view({
    label: 'Completed reply',
    state: 'completed',
    cancellable: false,
    presentation: { ref: 'speech-1', state: 'stop_requested', startedAtMs: 1000 },
  });
  const { rerender } = render(
    <CallActivity
      isAgentSpeaking
      tasks={[completed]}
      pendingTaskIds={new Set(['task-1'])}
      onCancel={onCancel}
    />
  );
  expect(screen.getByRole('button', { name: /^Stop speech/ })).toBeDisabled();
  rerender(
    <CallActivity
      isAgentSpeaking
      tasks={[completed]}
      pendingTaskIds={new Set()}
      onCancel={onCancel}
    />
  );
  const stop = screen.getByRole('button', { name: /^Stop speech/ });
  expect(stop).toBeEnabled();
  fireEvent.click(stop);
  fireEvent.click(stop);
  expect(onCancel.mock.calls).toEqual([
    ['task-1', 'speech-1'],
    ['task-1', 'speech-1'],
  ]);
  expect(screen.getByText('Stopping speech', { exact: true })).toBeVisible();
  rerender(<CallActivity isAgentSpeaking={false} tasks={[completed]} onCancel={onCancel} />);
  expect(screen.queryByRole('button', { name: /^Stop speech/ })).not.toBeInTheDocument();
});
