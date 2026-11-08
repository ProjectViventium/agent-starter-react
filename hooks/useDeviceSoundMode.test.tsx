import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { DEVICE_SOUND_MODE_KEY, useDeviceSoundMode } from './useDeviceSoundMode';

const stored = new Map<string, string>();
const storage = {
  getItem: vi.fn((key: string) => stored.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => {
    stored.set(key, value);
  }),
};
beforeEach(() => {
  stored.clear();
  storage.getItem.mockReset().mockImplementation((key) => stored.get(key) ?? null);
  storage.setItem.mockReset().mockImplementation((key, value) => {
    stored.set(key, value);
  });
  vi.stubGlobal('localStorage', storage);
});
afterEach(() => vi.unstubAllGlobals());
describe('device sound preference', () => {
  it('defaults to standard and retains an explicit choice across reload', () => {
    const first = renderHook(() => useDeviceSoundMode());
    expect(first.result.current.mode).toBe('standard');
    act(() => first.result.current.selectMode('earpiece'));
    first.unmount();
    const next = renderHook(() => useDeviceSoundMode());
    expect(next.result.current.mode).toBe('earpiece');
    act(() => next.result.current.selectMode('standard'));
    expect(window.localStorage.getItem(DEVICE_SOUND_MODE_KEY)).toBe('standard');
  });
  it('keeps calls usable and reports a failed local save', () => {
    storage.getItem.mockImplementation(() => {
      throw new Error('blocked');
    });
    storage.setItem.mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useDeviceSoundMode());
    expect(result.current.ready).toBe(true);
    act(() => result.current.selectMode('earpiece'));
    expect(result.current.mode).toBe('earpiece');
    expect(result.current.notice).toContain('could not save');
  });
});
