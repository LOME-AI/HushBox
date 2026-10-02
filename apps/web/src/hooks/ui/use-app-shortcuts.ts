import { useHotkeys, type Hotkey } from '@hushbox/ui';
import { useSession } from '@/lib/auth/auth';
import { APP_ACTIONS, type AppActionContext } from '@/lib/app-actions';
import { usePaletteStore } from '@/stores/ui/palette';

/** The app's global shortcuts, as `useHotkeys` combos; the palette's rows draw the same ones. */
export const APP_SHORTCUTS = {
  palette: 'mod+k',
  newChat: 'mod+shift+o',
  settings: 'mod+,',
} as const;

/**
 * The palette toggle, New chat and Settings, live from any field including the composer.
 * Settings is registered only for a signed-in account, so without one its combo stays the
 * browser's.
 */
export function useAppShortcuts(context: AppActionContext): void {
  const togglePalette = usePaletteStore((state) => state.toggle);
  const signedIn = useSession().data !== null;

  const hotkeys: Hotkey[] = [
    {
      combo: APP_SHORTCUTS.palette,
      description: 'Search chats and actions',
      whileTyping: true,
      onTrigger: togglePalette,
    },
    {
      combo: APP_SHORTCUTS.newChat,
      description: 'New chat',
      whileTyping: true,
      onTrigger: () => {
        APP_ACTIONS.newChat.run(context);
      },
    },
  ];
  if (signedIn) {
    hotkeys.push({
      combo: APP_SHORTCUTS.settings,
      description: 'Settings',
      whileTyping: true,
      onTrigger: () => {
        APP_ACTIONS.settings.run(context);
      },
    });
  }
  useHotkeys(hotkeys);
}
