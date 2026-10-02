import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { makeFinding } from '@/test-utils/finding-fixture';
import { useFindingStore } from './use-finding-store';

const initial = [
  makeFinding({ id: 'A-1', state: 'open' }),
  makeFinding({ id: 'A-2', state: 'open' }),
];

describe('useFindingStore', () => {
  it('starts from the findings it was given', () => {
    const { result } = renderHook(() => useFindingStore(initial));

    expect(result.current.findings).toEqual(initial);
  });

  it('replaces one finding in place', () => {
    const { result } = renderHook(() => useFindingStore(initial));

    act(() => {
      result.current.put(makeFinding({ id: 'A-1', state: 'denied' }));
    });

    expect(result.current.findings.map((finding) => finding.id)).toEqual(['A-1', 'A-2']);
    expect(result.current.findings[0]?.state).toBe('denied');
    expect(result.current.findings[1]).toBe(initial[1]);
  });

  it('ignores a finding the audit does not hold', () => {
    const { result } = renderHook(() => useFindingStore(initial));

    act(() => {
      result.current.put(makeFinding({ id: 'ghost' }));
    });

    expect(result.current.findings).toEqual(initial);
  });

  it('reseeds when a fresh snapshot arrives', () => {
    const { result, rerender } = renderHook(({ seed }) => useFindingStore(seed), {
      initialProps: { seed: initial },
    });
    const replacement = [makeFinding({ id: 'B-1' })];

    rerender({ seed: replacement });

    expect(result.current.findings).toEqual(replacement);
  });
});
