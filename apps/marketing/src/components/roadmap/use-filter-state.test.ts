import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFilterState, ALL_STATUSES, ALL_TYPES } from './use-filter-state';

describe('useFilterState', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/roadmap');
  });

  it('defaults to all statuses and types selected', () => {
    const { result } = renderHook(() => useFilterState());
    expect([...result.current.statuses].sort()).toEqual([...ALL_STATUSES].sort());
    expect([...result.current.types].sort()).toEqual([...ALL_TYPES].sort());
  });

  it('reads initial state from the URL when present', () => {
    window.history.replaceState(null, '', '/roadmap?status=in_progress&type=feature');
    const { result } = renderHook(() => useFilterState());
    expect([...result.current.statuses]).toEqual(['in_progress']);
    expect([...result.current.types]).toEqual(['feature']);
  });

  it('ignores unknown URL values gracefully (falls back to all-on)', () => {
    window.history.replaceState(null, '', '/roadmap?status=garbage');
    const { result } = renderHook(() => useFilterState());
    expect(result.current.statuses.size).toBe(ALL_STATUSES.length);
  });

  it('toggleStatus removes a present status', () => {
    const { result } = renderHook(() => useFilterState());
    act(() => result.current.toggleStatus('shipped'));
    expect(result.current.statuses.has('shipped')).toBe(false);
    expect(result.current.statuses.has('in_progress')).toBe(true);
  });

  it('toggleStatus snaps to all-on when the last status is removed', () => {
    const { result } = renderHook(() => useFilterState());
    act(() => result.current.toggleStatus('in_progress'));
    act(() => result.current.toggleStatus('planned'));
    act(() => result.current.toggleStatus('shipped'));
    expect(result.current.statuses.size).toBe(ALL_STATUSES.length);
  });

  it('toggleType removes a present type', () => {
    const { result } = renderHook(() => useFilterState());
    act(() => result.current.toggleType('bug'));
    expect(result.current.types.has('bug')).toBe(false);
    expect(result.current.types.has('feature')).toBe(true);
  });

  it('toggleType snaps to all-on when the last type is removed', () => {
    const { result } = renderHook(() => useFilterState());
    act(() => result.current.toggleType('feature'));
    act(() => result.current.toggleType('bug'));
    expect(result.current.types.size).toBe(ALL_TYPES.length);
  });

  it('writes non-default selections to the URL', () => {
    const { result } = renderHook(() => useFilterState());
    act(() => result.current.toggleStatus('shipped'));
    expect(window.location.search).toContain('status=');
  });

  it('removes the URL param when state returns to default', () => {
    const { result } = renderHook(() => useFilterState());
    act(() => result.current.toggleStatus('shipped'));
    act(() => result.current.toggleStatus('shipped'));
    expect(window.location.search).not.toContain('status=');
  });
});
