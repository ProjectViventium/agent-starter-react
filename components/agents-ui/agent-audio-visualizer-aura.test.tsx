import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { AgentAudioVisualizerAura } from './agent-audio-visualizer-aura';

vi.mock('@livekit/components-react', () => ({ useTrackVolume: () => 0 }));
afterEach(cleanup);

describe('native aura', () => {
  it('responds to audio levels without a WebGL context or external asset', () => {
    const { container, rerender } = render(
      <AgentAudioVisualizerAura state="speaking" volume={0} />
    );
    const quiet = container.querySelector('circle')!.getAttribute('r');
    rerender(<AgentAudioVisualizerAura state="speaking" volume={1} />);
    expect(Number(container.querySelector('circle')!.getAttribute('r'))).toBeGreaterThan(
      Number(quiet)
    );
    expect(container.querySelector('canvas, image, iframe')).toBeNull();
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('keeps malformed volume bounded and honors state, theme, color and reduced motion', () => {
    const { container } = render(
      <AgentAudioVisualizerAura
        state="thinking"
        volume={NaN}
        color="#123456"
        colorShift={Infinity}
        themeMode="light"
        size="sm"
        aria-label="Assistant"
      />
    );
    expect(container.firstChild).toHaveAttribute('data-lk-state', 'thinking');
    expect(container.firstChild).toHaveAttribute('data-theme', 'light');
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
    expect(container.querySelector('[stroke="#123456"]')).toBeTruthy();
    expect(container.querySelector('.motion-reduce\\:animate-none')).toBeTruthy();
  });
});
