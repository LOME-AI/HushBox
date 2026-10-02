import * as React from 'react';
import { CommandPalette, Kbd, type PaletteSection } from '@hushbox/ui';
import { ROUTES, TEST_IDS } from '@hushbox/shared';
import { useSession } from '@/lib/auth/auth';
import { useDecryptedConversations } from '@/hooks/chat/chat';
import { APP_ACTIONS, type AppActionContext } from '@/lib/app-actions';
import { usePaletteStore } from '@/stores/ui/palette';
import { webPaletteSections, type WebPaletteItem } from './palette-items';

/** A row with a shortcut draws it as keycaps where its meta goes, as the reference does. */
function withShortcutMeta(item: WebPaletteItem): WebPaletteItem {
  if (item.kind !== 'action' || item.shortcut === undefined) return item;
  return { ...item, meta: <Kbd combo={item.shortcut} form="keycaps" /> };
}

function NoMatch(): React.JSX.Element {
  return (
    <p className="text-muted-foreground px-4 pt-2 pb-5 text-sm text-pretty">
      Nothing matches. Search covers actions, pages and the chats loaded in your sidebar.
    </p>
  );
}

/**
 * The web app's palette: recent conversations, the shared app actions and the pages, opened
 * from the palette store by Search, the rail or the shortcut.
 */
export function WebCommandPalette({
  context,
}: Readonly<{ context: AppActionContext }>): React.JSX.Element {
  const open = usePaletteStore((state) => state.open);
  const setOpen = usePaletteStore((state) => state.setOpen);
  const signedIn = useSession().data !== null;
  const conversations = useDecryptedConversations().data ?? [];

  function sections(query: string): readonly PaletteSection<WebPaletteItem>[] {
    return webPaletteSections({ query, conversations, signedIn, now: new Date() }).map(
      (section) => ({ ...section, items: section.items.map((item) => withShortcutMeta(item)) })
    );
  }

  function run(item: WebPaletteItem): void {
    if (item.kind === 'action') {
      APP_ACTIONS[item.action].run(context);
      return;
    }
    context.closeDrawer();
    void context.navigate({
      to: ROUTES.CHAT_ID,
      params: { id: item.conversationId },
      search: { fork: undefined },
    });
  }

  return (
    <CommandPalette
      open={open}
      onClose={() => {
        setOpen(false);
      }}
      sections={sections}
      onRun={run}
      empty={<NoMatch />}
      title="Search chats and actions"
      description="Type to filter. Up and down arrows move through the results, and Enter opens one."
      placeholder="Search chats, actions, settings"
      testId={TEST_IDS.commandPalette}
      inputTestId={TEST_IDS.commandPaletteInput}
      optionTestId={TEST_IDS.commandPaletteOption}
    />
  );
}
