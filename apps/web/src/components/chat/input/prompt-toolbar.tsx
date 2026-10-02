import * as React from 'react';
import { REASONING_EFFORT_LABELS } from '@hushbox/shared';
import { LAYOUT } from '@hushbox/shared/design-tokens';
import { MenuItem, MenuSeparator } from '@hushbox/ui/menu';
import { Gauge, Globe } from '@hushbox/ui/icons';
import { AiRepliesChip } from '@/components/chat/input/ai-replies-chip';
import { ModeMenu } from '@/components/chat/input/mode-menu';
import { SEARCH_VISITOR_REASON, SearchChip } from '@/components/chat/input/search-chip';
import { useReasoningEffort } from '@/hooks/chat/use-reasoning-effort';
import type { usePayerPremiumAccess } from '@/hooks/models/use-payer-premium-access';
import type { ChatModality } from '@hushbox/shared';

/**
 * Props controlling the web-search toggle. Grouped into one object because
 * the fields are only meaningful together — absent means "this prompt
 * has no search feature" (e.g. image modality).
 */
export interface ChatSearchProps {
  /** Whether web search is currently enabled (effective state from useWebSearch). */
  webSearchEnabled: boolean;
  /** Whether the user may use web search (authenticated-only); drives the toggle's enabled state. */
  canUseWebSearch: boolean;
  /** Called when the user toggles web search. */
  onToggleWebSearch: () => void;
}

type PayerPremiumAccess = ReturnType<typeof usePayerPremiumAccess>;

interface PromptToolbarProps {
  readonly activeModality: ChatModality | undefined;
  readonly isAuthenticated: boolean | undefined;
  readonly premiumAccess: PayerPremiumAccess;
  readonly onSelectModality: ((modality: ChatModality) => void) | undefined;
  readonly searchProps: ChatSearchProps | undefined;
  readonly isGroupChat: boolean;
  readonly aiEnabled: boolean;
  readonly onToggleAi: () => void;
  readonly audioModalityEnabled: boolean;
  /** The composer's field, which the mode menu opens against. */
  readonly modeMenuAnchor?: React.RefObject<HTMLElement | null> | undefined;
  /** Rows the mode menu adds after the modes. */
  readonly modeMenuRows?: React.ReactNode;
  /** Given the mode menu's "+". */
  readonly modeMenuTriggerRef?: React.RefObject<HTMLButtonElement | null> | undefined;
}

export function PromptToolbar({
  activeModality,
  isAuthenticated,
  premiumAccess,
  onSelectModality,
  searchProps,
  isGroupChat,
  aiEnabled,
  onToggleAi,
  audioModalityEnabled,
  modeMenuAnchor,
  modeMenuRows,
  modeMenuTriggerRef,
}: Readonly<PromptToolbarProps>): React.JSX.Element {
  // The mode menu renders whenever the parent supplies the props. A viewer who
  // may not enter a mode sees it locked with the reason that names their remedy,
  // so the affordance stays discoverable instead of being hidden.
  const showModality =
    activeModality !== undefined && onSelectModality !== undefined && isAuthenticated !== undefined;
  const showSearch = searchProps !== undefined && isAuthenticated !== undefined;

  // The mode menu's "+" and chip sit straight in the composer's group, so the
  // group's own gap spaces them; the icon toggles keep their tighter cluster.
  return (
    <>
      {showModality && (
        <ModeMenu
          activeModality={activeModality}
          onSelect={onSelectModality}
          isAuthenticated={isAuthenticated}
          premiumAccess={premiumAccess}
          audioEnabled={audioModalityEnabled}
          anchor={modeMenuAnchor}
          extraRows={modeMenuRows}
          triggerRef={modeMenuTriggerRef}
        />
      )}
      <div className="flex items-center gap-1">
        {showSearch && (
          <SearchChip
            webSearchEnabled={searchProps.webSearchEnabled}
            canUse={searchProps.canUseWebSearch}
            onToggle={searchProps.onToggleWebSearch}
          />
        )}
        {isGroupChat && <AiRepliesChip enabled={aiEnabled} onToggle={onToggleAi} />}
      </div>
    </>
  );
}

/**
 * Whether `element` is narrower than `width`, a rem length, compared the way a container query
 * compares it: against the root's font size, so larger text narrows the same box.
 */
function narrowerThan(element: HTMLElement | null, width: string): boolean {
  if (element === null) return false;
  const rootPx = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return element.getBoundingClientRect().width < Number.parseFloat(width) * rootPx;
}

/** Whether the composer is under the width at which its bar gives up Search and Effort. */
function useComposerBelowMinimal(composer: React.RefObject<HTMLElement | null>): boolean {
  const subscribe = React.useCallback(
    (notify: () => void): (() => void) => {
      const element = composer.current;
      if (element === null) return (): void => undefined;
      const observer = new ResizeObserver(notify);
      observer.observe(element);
      return (): void => {
        observer.disconnect();
      };
    },
    [composer]
  );
  return React.useSyncExternalStore(subscribe, () =>
    narrowerThan(composer.current, LAYOUT.containers['composer-minimal'])
  );
}

function EffortRow({ onOpen }: Readonly<{ onOpen: () => void }>): React.JSX.Element | null {
  const { effective } = useReasoningEffort();
  if (effective === undefined) return null;
  const word = REASONING_EFFORT_LABELS[effective];
  return (
    <MenuItem
      icon={Gauge}
      title={
        <>
          <span className="sr-only">Effort: {word}</span>
          <span aria-hidden="true">Effort</span>
        </>
      }
      end={
        <span aria-hidden="true" className="text-ui-sm tracking-normal">
          {word}
        </span>
      }
      onSelect={onOpen}
    />
  );
}

interface ComposerNarrowRowsProps {
  /** The composer whose width decides whether the rows show. */
  readonly composer: React.RefObject<HTMLElement | null>;
  /** The composer's search toggle, absent where it offers none. */
  readonly search: ChatSearchProps | undefined;
  /** Opens the effort menu. */
  readonly onOpenEffort: () => void;
}

/**
 * The mode menu's rows for the controls a composer under 20rem drops from its bar: Search, with
 * its state, and Effort, with its word, which opens the effort menu. The width is read as the
 * menu opens, since the menu renders outside the composer and no container query reaches it.
 */
export function ComposerNarrowRows({
  composer,
  search,
  onOpenEffort,
}: Readonly<ComposerNarrowRowsProps>): React.JSX.Element | null {
  const narrow = useComposerBelowMinimal(composer);
  if (!narrow) return null;
  return (
    <>
      <MenuSeparator />
      {search !== undefined && (
        <MenuItem
          icon={Globe}
          title="Search"
          checked={search.canUseWebSearch && search.webSearchEnabled}
          onSelect={search.onToggleWebSearch}
          {...(!search.canUseWebSearch && {
            disabled: true,
            disabledReason: SEARCH_VISITOR_REASON,
          })}
        />
      )}
      <EffortRow onOpen={onOpenEffort} />
    </>
  );
}
