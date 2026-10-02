import * as React from 'react';
import { useParams } from '@tanstack/react-router';
import { PRE_CREATION_CONVERSATION_ID, TEST_IDS } from '@hushbox/shared';
import { SkipLink } from '@hushbox/ui';
import { Sidebar } from '@/components/sidebar/sidebar';
import { NotificationActivityLayer } from '@/components/notifications/notification-activity-layer';
import { FeedbackModal } from '@/components/feedback/feedback-modal';
import { AccessibilityPanelHost } from '@/components/accessibility/accessibility-panel-host';
import { RightPaneHostContext } from '@/components/shared/right-pane';
import { WebCommandPalette } from '@/components/command-palette/web-command-palette';
import { useUIModalsStore } from '@/stores/ui/modals';
import { useAppShortcuts } from '@/hooks/ui/use-app-shortcuts';
import { useAppActionContext } from '@/hooks/ui/use-app-action-context';
import { useModelValidation } from '@/hooks/models/use-model-validation';
import { usePushRegistration } from '@/hooks/notifications/use-push-registration';

interface AppShellProps {
  children: React.ReactNode;
}

/**
 * The conversation whose owner funds what is composed under the shell, or
 * `null` when there is none. The shell renders on every route, so the params
 * are read non-strictly: `$id` on the chat route and `$conversationId` on the
 * share route, which is where a link guest — funded by the owner — arrives.
 * `new` is the placeholder for a conversation that does not exist yet, whose
 * payer is the caller.
 */
function useShellConversationId(): string | null {
  const params = useParams({ strict: false });
  const id = params.conversationId ?? params.id;
  return id === undefined || id === PRE_CREATION_CONVERSATION_ID ? null : id;
}

/**
 * The feedback dialog is mounted here rather than beside the menu that opens it: on a phone
 * that menu sits in the drawer, which unmounts as the choice closes it.
 */
function ShellFeedbackModal(): React.JSX.Element | null {
  const open = useUIModalsStore((state) => state.feedbackOpen);
  const setOpen = useUIModalsStore((state) => state.setFeedbackOpen);
  return <FeedbackModal open={open} onOpenChange={setOpen} />;
}

export function AppShell({ children }: Readonly<AppShellProps>): React.JSX.Element {
  useModelValidation(useShellConversationId());
  usePushRegistration();
  const actionContext = useAppActionContext();
  useAppShortcuts(actionContext);
  // The slot's element arrives through a state setter used as its callback ref, so a
  // pane rendered below renders once the element exists.
  const [rightPaneHost, setRightPaneHost] = React.useState<HTMLElement | null>(null);

  return (
    <RightPaneHostContext value={rightPaneHost}>
      <div data-testid={TEST_IDS.appShell} className="bg-background flex h-full">
        <SkipLink />

        {/* Renders only a screen-reader live region; it exists here so the
          activity count, tab title, and app badge have one owner for the whole
          authenticated app. */}
        <NotificationActivityLayer />

        <Sidebar />

        {/* Main content area — min-h-0 prevents flex items from inheriting their
          children's min-content height and pushing past the height allocated by
          the root route's h-dvh banner-row layout (the shell is h-full inside
          its flex-1 region, paired with the html/body overflow-hidden cap in
          app.css). id + tabIndex make it the skip link's focus target. */}
        <main id="main" tabIndex={-1} className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {children}
        </main>

        {/* Portal target for right sidebar — display:contents makes it invisible to flex layout */}
        <div id="right-sidebar-portal" className="contents" />

        {/* The one right pane; display:contents makes the pane itself the row's flex item. */}
        <div ref={setRightPaneHost} data-right-pane-slot="" className="contents" />

        <AccessibilityPanelHost />

        <ShellFeedbackModal />

        <WebCommandPalette context={actionContext} />
      </div>
    </RightPaneHostContext>
  );
}
