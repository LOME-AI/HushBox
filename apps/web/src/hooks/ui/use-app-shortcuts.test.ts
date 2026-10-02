import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { fireEvent, renderHook } from '@testing-library/react';
import { ROUTES } from '@hushbox/shared';
import { useAuthStore } from '@/lib/auth/auth';
import { clearLinkGuestAuth, setLinkGuestAuth } from '@/lib/auth/link-guest-auth';
import { APP_ACTIONS, type AppActionContext } from '@/lib/app-actions';
import { usePaletteStore } from '@/stores/ui/palette';
import { useAppShortcuts } from './use-app-shortcuts';

interface ContextSpies {
  context: AppActionContext;
  /** What the context's `navigate` was called with; the router's type is generic, so no mock is one. */
  navigate: Mock<(options: unknown) => void>;
  closeDrawer: Mock<AppActionContext['closeDrawer']>;
}

function makeContext(): ContextSpies {
  const navigateSpy = vi.fn<(options: unknown) => void>();
  const navigate: AppActionContext['navigate'] = (options) => {
    navigateSpy(options);
    return Promise.resolve();
  };
  const closeDrawer = vi.fn<AppActionContext['closeDrawer']>();
  const openFeedback = vi.fn<AppActionContext['openFeedback']>();
  return { context: { navigate, closeDrawer, openFeedback }, navigate: navigateSpy, closeDrawer };
}

function signIn(): void {
  useAuthStore.getState().setUser({
    id: 'user-1',
    email: 'reader@hushbox.ai',
    username: 'reader',
    emailVerified: true,
    totpEnabled: false,
    hasAcknowledgedPhrase: true,
  });
  useAuthStore.getState().setLoading(false);
}

/** A key pressed in a fresh textarea, as the composer would receive it. */
function pressInTextarea(init: KeyboardEventInit): KeyboardEvent {
  const textarea = document.createElement('textarea');
  document.body.append(textarea);
  textarea.focus();
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  textarea.dispatchEvent(event);
  textarea.remove();
  return event;
}

beforeEach(() => {
  usePaletteStore.setState({ open: false });
  useAuthStore.getState().setUser(null);
});

afterEach(() => {
  clearLinkGuestAuth();
  vi.restoreAllMocks();
});

describe('useAppShortcuts', () => {
  it('opens the palette on Ctrl K', () => {
    renderHook(() => {
      useAppShortcuts(makeContext().context);
    });
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    expect(usePaletteStore.getState().open).toBe(true);
  });

  it('closes an open palette on Ctrl K', () => {
    usePaletteStore.setState({ open: true });
    renderHook(() => {
      useAppShortcuts(makeContext().context);
    });
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    expect(usePaletteStore.getState().open).toBe(false);
  });

  it('opens the palette on Ctrl K from a text field', () => {
    renderHook(() => {
      useAppShortcuts(makeContext().context);
    });
    pressInTextarea({ key: 'k', ctrlKey: true });
    expect(usePaletteStore.getState().open).toBe(true);
  });

  it('never opens the palette for a K typed without a modifier', () => {
    renderHook(() => {
      useAppShortcuts(makeContext().context);
    });
    pressInTextarea({ key: 'k' });
    fireEvent.keyDown(document.body, { key: 'k' });
    expect(usePaletteStore.getState().open).toBe(false);
  });

  it('starts a new chat through the app action on Ctrl Shift O', () => {
    const run = vi.spyOn(APP_ACTIONS.newChat, 'run');
    const { context } = makeContext();
    renderHook(() => {
      useAppShortcuts(context);
    });
    fireEvent.keyDown(document.body, { key: 'O', ctrlKey: true, shiftKey: true });
    expect(run).toHaveBeenCalledWith(context);
  });

  it('starts a new chat on Ctrl Shift O from the composer', () => {
    const { context, navigate } = makeContext();
    renderHook(() => {
      useAppShortcuts(context);
    });
    const event = pressInTextarea({ key: 'O', ctrlKey: true, shiftKey: true });
    expect(navigate).toHaveBeenCalledWith({ to: ROUTES.CHAT });
    expect(event.defaultPrevented).toBe(true);
  });

  it('starts a new chat on Ctrl Shift O without a session', () => {
    const { context, navigate } = makeContext();
    renderHook(() => {
      useAppShortcuts(context);
    });
    fireEvent.keyDown(document.body, { key: 'O', ctrlKey: true, shiftKey: true });
    expect(navigate).toHaveBeenCalledWith({ to: ROUTES.CHAT });
  });

  it('opens Settings through the app action on Ctrl comma', () => {
    signIn();
    const run = vi.spyOn(APP_ACTIONS.settings, 'run');
    const { context } = makeContext();
    renderHook(() => {
      useAppShortcuts(context);
    });
    fireEvent.keyDown(document.body, { key: ',', ctrlKey: true });
    expect(run).toHaveBeenCalledWith(context);
  });

  it('opens Settings on Ctrl comma from the composer', () => {
    signIn();
    const { context, navigate } = makeContext();
    renderHook(() => {
      useAppShortcuts(context);
    });
    pressInTextarea({ key: ',', ctrlKey: true });
    expect(navigate).toHaveBeenCalledWith({ to: ROUTES.SETTINGS });
  });

  it('leaves Ctrl comma alone for a trial visitor', () => {
    const { context, navigate } = makeContext();
    renderHook(() => {
      useAppShortcuts(context);
    });
    const event = pressInTextarea({ key: ',', ctrlKey: true });
    expect(navigate).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('leaves Ctrl comma alone for a link guest', () => {
    signIn();
    setLinkGuestAuth('bGluay1ndWVzdA==');
    const { context, navigate } = makeContext();
    renderHook(() => {
      useAppShortcuts(context);
    });
    fireEvent.keyDown(document.body, { key: ',', ctrlKey: true });
    expect(navigate).not.toHaveBeenCalled();
  });
});
