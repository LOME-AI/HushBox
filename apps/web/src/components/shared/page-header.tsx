import * as React from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from '@tanstack/react-router';
import { SquarePen } from 'lucide-react';
import { ROUTES, TEST_IDS } from '@hushbox/shared';
import { IconButton } from '@hushbox/ui/button';
import { Heading } from '@hushbox/ui/type';
import { PageShellContext } from '@/components/shared/page-shell';

interface PageHeaderProps {
  title?: string | undefined;
  titleTestId?: string;
  center?: React.ReactNode;
  shield?: React.ReactNode;
  facepile?: React.ReactNode;
  /** Shown under the header below 768. */
  strip?: React.ReactNode;
  showNewChat?: boolean;
  /** The test id the shell's header carries while this page is mounted. */
  testId?: string;
}

function NewChatIcon(): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <IconButton
      icon={SquarePen}
      aria-label="New Chat"
      data-testid={TEST_IDS.headerNewChat}
      className="text-muted-foreground hover:text-foreground"
      onClick={() => {
        void navigate({ to: ROUTES.CHAT });
      }}
    />
  );
}

function into(target: HTMLElement | null, node: React.ReactNode): React.ReactPortal | null {
  return target === null || node === undefined || node === false
    ? null
    : createPortal(node, target);
}

/**
 * Fills the page-specific parts of the `PageShell` header. It draws nothing where it
 * renders: each prop is portalled into its slot, so the content keeps the context of
 * the page that renders it.
 */
export function PageHeader({
  title,
  titleTestId = 'page-header-title',
  center,
  shield,
  facepile,
  strip,
  showNewChat = false,
  testId,
}: Readonly<PageHeaderProps>): React.JSX.Element | null {
  const shell = React.useContext(PageShellContext);
  const setHeaderTestId = shell?.setHeaderTestId;

  React.useLayoutEffect(() => {
    if (setHeaderTestId === undefined) return;
    setHeaderTestId(testId);
    return (): void => {
      setHeaderTestId(undefined);
    };
  }, [setHeaderTestId, testId]);

  if (shell === null) return null;
  const { slots } = shell;

  const heading = title !== undefined && title !== '' && (
    <div data-testid={titleTestId} title={title} className="min-w-0">
      <Heading level={1} variant="header-title" truncate>
        {title}
      </Heading>
    </div>
  );

  return (
    <>
      {into(slots.title, heading)}
      {into(slots.center, center)}
      {into(slots.shield, shield)}
      {into(slots.facepile, facepile)}
      {into(slots.newChat, showNewChat && <NewChatIcon />)}
      {into(slots.strip, strip)}
    </>
  );
}
