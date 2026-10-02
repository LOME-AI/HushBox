import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useUIStore } from '@/stores/ui/ui';
import { useUIModalsStore } from '@/stores/ui/modals';
import { useAppActionContext } from './use-app-action-context';

/** The one navigate the mocked router hands out, so a test can compare it by identity. */
const { routerNavigate } = vi.hoisted(() => ({ routerNavigate: vi.fn() }));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => routerNavigate,
}));

beforeEach(() => {
  useUIStore.setState({ mobileSidebarOpen: false });
  useUIModalsStore.setState({ feedbackOpen: false });
});

describe('useAppActionContext', () => {
  it("navigates with the router's navigate", () => {
    const { result } = renderHook(() => useAppActionContext());
    expect(result.current.navigate).toBe(routerNavigate);
  });

  it('closes the phone drawer', () => {
    useUIStore.setState({ mobileSidebarOpen: true });
    const { result } = renderHook(() => useAppActionContext());
    act(() => {
      result.current.closeDrawer();
    });
    expect(useUIStore.getState().mobileSidebarOpen).toBe(false);
  });

  it('opens the feedback dialog', () => {
    const { result } = renderHook(() => useAppActionContext());
    act(() => {
      result.current.openFeedback();
    });
    expect(useUIModalsStore.getState().feedbackOpen).toBe(true);
  });

  it('keeps one context across renders', () => {
    const { result, rerender } = renderHook(() => useAppActionContext());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
