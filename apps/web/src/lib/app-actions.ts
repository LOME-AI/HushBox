import { ROUTES } from '@hushbox/shared';
import type { NavigateFn } from '@tanstack/react-router';

/** What an action needs from the surface that runs it: the account menu or the palette. */
export interface AppActionContext {
  navigate: NavigateFn;
  /** Dismisses the phone drawer; a no-op where there is none. */
  closeDrawer: () => void;
  openFeedback: () => void;
}

type AppActionKey =
  | 'newChat'
  | 'settings'
  | 'usage'
  | 'addCredit'
  | 'sendFeedback'
  | 'accessibilityPage';

interface AppAction {
  run(ctx: AppActionContext): void;
  /** Offered only to a signed-in account. */
  requiresSession: boolean;
}

// The drawer closes before anything else: a choice that lands on the route already open
// changes no pathname, so the sidebar's own close-on-navigate never fires for it.
function goTo(to: string, requiresSession: boolean): AppAction {
  return {
    run: ({ navigate, closeDrawer }) => {
      closeDrawer();
      void navigate({ to });
    },
    requiresSession,
  };
}

/** The actions the account menu and the command palette share, so both run them alike. */
export const APP_ACTIONS: Readonly<Record<AppActionKey, AppAction>> = {
  newChat: goTo(ROUTES.CHAT, false),
  settings: goTo(ROUTES.SETTINGS, true),
  usage: goTo(ROUTES.USAGE, true),
  addCredit: goTo(ROUTES.BILLING, true),
  sendFeedback: {
    run: ({ closeDrawer, openFeedback }) => {
      closeDrawer();
      openFeedback();
    },
    requiresSession: true,
  },
  accessibilityPage: goTo(ROUTES.ACCESSIBILITY, false),
};
