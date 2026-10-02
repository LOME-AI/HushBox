import * as React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, type RenderHookResult } from '@testing-library/react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { useTypeFilter } from './use-type-filter';
import type { TypeFilterValue } from './types';

function ShowType(): React.JSX.Element {
  const { type } = useTypeFilter();
  return <p>{type}</p>;
}

function renderAt(url: string): RenderHookResult<ReturnType<typeof useTypeFilter>, unknown> {
  globalThis.history.replaceState(null, '', url);
  return renderHook(() => useTypeFilter());
}

describe('useTypeFilter', () => {
  beforeEach(() => {
    globalThis.history.replaceState(null, '', '/roadmap');
  });

  it('shows every type when the URL names none', () => {
    expect(renderAt('/roadmap').result.current.type).toBe('all');
  });

  it('reads features from ?type=feature', () => {
    expect(renderAt('/roadmap?type=feature').result.current.type).toBe('feature');
  });

  it('reads bugs from ?type=bug', () => {
    expect(renderAt('/roadmap?type=bug').result.current.type).toBe('bug');
  });

  it('shows every type for an unknown type value', () => {
    expect(renderAt('/roadmap?type=garbage').result.current.type).toBe('all');
  });

  it('shows every type for the old two-type list', () => {
    expect(renderAt('/roadmap?type=feature,bug').result.current.type).toBe('all');
  });

  it('ignores the old status parameter', () => {
    expect(renderAt('/roadmap?status=shipped').result.current.type).toBe('all');
  });

  it('writes the chosen type to the URL', () => {
    const { result } = renderAt('/roadmap');
    act(() => {
      result.current.setType('bug');
    });
    expect(result.current.type).toBe('bug');
    expect(globalThis.location.search).toBe('?type=bug');
  });

  it('clears the type from the URL when All is chosen', () => {
    const { result } = renderAt('/roadmap?type=feature');
    act(() => {
      result.current.setType('all');
    });
    expect(result.current.type).toBe('all');
    expect(globalThis.location.search).toBe('');
  });

  it('keeps unrelated URL parameters when the type changes', () => {
    const { result } = renderAt('/roadmap?ref=news');
    act(() => {
      result.current.setType('feature');
    });
    expect(new URLSearchParams(globalThis.location.search).get('ref')).toBe('news');
  });

  it('keeps the page path when the type changes', () => {
    const { result } = renderAt('/roadmap');
    act(() => {
      result.current.setType('feature');
    });
    expect(globalThis.location.pathname).toBe('/roadmap');
  });

  it('renders All first, as the static page does, even when the URL names a type', () => {
    const seen: TypeFilterValue[] = [];
    globalThis.history.replaceState(null, '', '/roadmap?type=bug');
    renderHook(() => {
      const state = useTypeFilter();
      seen.push(state.type);
      return state;
    });
    expect(seen[0]).toBe('all');
  });

  it('hydrates a shared filtered link without a mismatch, then applies its type', async () => {
    globalThis.history.replaceState(null, '', '/roadmap');
    const container = document.createElement('div');
    container.innerHTML = renderToString(<ShowType />);
    document.body.append(container);
    globalThis.history.replaceState(null, '', '/roadmap?type=bug');
    const onRecoverableError = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      hydrateRoot(container, <ShowType />, { onRecoverableError });
      await Promise.resolve();
    });
    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(container.textContent).toBe('bug');
    consoleError.mockRestore();
    container.remove();
  });
});
