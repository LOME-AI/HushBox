import * as React from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { X } from 'lucide-react';
import { cn } from '@hushbox/ui';
import { IconButton } from '@hushbox/ui/button';
import { Overlay, OverlayTitle, useOverlayFocusReturn } from '@hushbox/ui/overlay';
import { useFormFactor } from '@hushbox/ui/platform';
import { useRightPane } from '@/stores/ui/right-pane';

/**
 * Whether the shown pane docks, as that pane decided it; `null` while no pane has decided. A
 * pane decides as it shows, before the page paints.
 */
const usePaneDockDecision = create<{ docked: boolean | null }>(() => ({ docked: null }));

/**
 * Whether the open pane docks, for the sidebar's rail, which folds beside a docked pane only.
 * `null` while no pane has decided.
 */
export function useOpenPaneDocks(): boolean | null {
  return usePaneDockDecision((state) => state.docked);
}

/** The shell's slot a right pane portals into; null outside the app shell. */
export const RightPaneHostContext = React.createContext<HTMLElement | null>(null);

type RightPaneWidth = '20rem' | '22rem';
type RightPanePhoneForm = 'fullscreen' | 'sheet';
type RightPaneSurface = 'background' | 'sidebar';
type RightPaneHead = 'plain' | 'display';

interface RightPaneProps {
  id: string;
  title: string;
  /** Muted beside the title, inside the heading. */
  titleAside?: React.ReactNode;
  width: RightPaneWidth;
  /** The pane's own surface; its borders take that surface's border colour. */
  surface: RightPaneSurface;
  /** `plain` sets the title in the reading title role; `display` draws it larger, with its own inset below 768. */
  head: RightPaneHead;
  phone: RightPanePhoneForm;
  onClose: () => void;
  'data-testid'?: string;
  children: React.ReactNode;
}

const SURFACE_CLASS: Readonly<Record<RightPaneSurface, string>> = {
  background: 'bg-background text-foreground border-border',
  sidebar: 'bg-sidebar text-sidebar-foreground border-sidebar-border',
};

// `plain` is the reading title role (`title-3-read`); no type role carries `display`'s size.
// The heading element rule supplies the red serif either way.
const TITLE_CLASS: Readonly<Record<RightPaneHead, string>> = {
  plain: 'text-title-3-read font-serif truncate',
  display: 'truncate text-[1.125rem] leading-[1.35] font-bold',
};

const HEAD_CLASS: Readonly<Record<RightPaneHead, string>> = {
  plain: 'min-h-[var(--app-header-height)] py-1 pl-4',
  display: 'min-h-0 pt-1 pb-2 pl-5',
};

/** What a head adds while docked. */
const DOCKED_HEAD_CLASS: Readonly<Record<RightPaneHead, string>> = {
  plain: '',
  display: 'md:min-h-[var(--app-header-height)] md:py-1 md:pl-4',
};

const DOCKED_WIDTH_CLASS: Readonly<Record<RightPaneWidth, string>> = {
  '20rem': 'md:w-[20rem]',
  '22rem': 'md:w-[22rem]',
};

const PANE_REM: Readonly<Record<RightPaneWidth, number>> = { '20rem': 20, '22rem': 22 };

// The thread beside a docked pane keeps the phone composer's own floor, so it stays usable.
const THREAD_FLOOR_REM = 20;

// The fit changes with the window's width and with the root font size, which the
// accessibility widget sets through classes and styles on <html>.
function subscribeToFit(onChange: () => void): () => void {
  globalThis.addEventListener('resize', onChange);
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style'],
  });
  return (): void => {
    globalThis.removeEventListener('resize', onChange);
    observer.disconnect();
  };
}

/**
 * Whether the pane docks: from 768, and only while the window holds the pane and a readable
 * thread beside it, measured in the reader's own rem.
 */
function useDocked(width: RightPaneWidth): boolean {
  const isPhone = useFormFactor().band === 'phone';
  const fits = React.useSyncExternalStore(subscribeToFit, () => {
    const rootPx = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    return globalThis.innerWidth >= (PANE_REM[width] + THREAD_FLOOR_REM) * rootPx;
  });
  return !isPhone && fits;
}

function headClass(head: RightPaneHead, docked: boolean): string {
  return cn(
    'flex shrink-0 items-center gap-1 border-b border-inherit pr-2',
    HEAD_CLASS[head],
    docked && DOCKED_HEAD_CLASS[head]
  );
}

function paneClass(
  surface: RightPaneSurface,
  phone: RightPanePhoneForm,
  width: RightPaneWidth,
  docked: boolean
): string {
  return cn(
    'z-drawer flex flex-col outline-none',
    SURFACE_CLASS[surface],
    'animate-in duration-300',
    PHONE_FORM_CLASS[phone],
    docked && [
      DOCKED_FORM_CLASS[phone],
      'md:static md:inset-auto md:h-full md:shrink-0 md:border-l',
      DOCKED_WIDTH_CLASS[width],
    ]
  );
}

function handleClass(docked: boolean): string {
  return cn(
    'bg-muted-foreground/30 mx-auto mt-2 h-1 w-10 shrink-0 rounded-full',
    docked && 'md:hidden'
  );
}

// Docked, from 768 and only where a thread fits beside it, the pane is a flex item of the
// shell's row, beside the main column, so the conversation narrows to make room. Otherwise the
// sheet lies over the page's foot, and the full-screen form renders as a modal overlay rather
// than as this element.
const PHONE_FORM_CLASS: Readonly<Record<RightPanePhoneForm, string>> = {
  fullscreen: 'slide-in-from-right',
  sheet: 'fixed inset-x-0 bottom-0 h-[62dvh] rounded-t-xl border-t shadow-lg slide-in-from-bottom',
};

/** What a phone form gives up while docked. */
const DOCKED_FORM_CLASS: Readonly<Record<RightPanePhoneForm, string>> = {
  fullscreen: '',
  sheet:
    'md:slide-in-from-bottom-0 md:slide-in-from-right md:rounded-none md:border-t-0 md:shadow-none',
};

/**
 * One right pane, drawn in the shell's slot while it is the open one. Opening another
 * pane replaces it, and the sidebar folds to its rail while it is docked. The sheet
 * form is non-modal: the page above it stays live, so a change made in the pane shows
 * as it is made.
 */
export function RightPane({
  id,
  title,
  titleAside,
  width,
  surface,
  head,
  phone,
  onClose,
  'data-testid': testId,
  children,
}: Readonly<RightPaneProps>): React.JSX.Element | null {
  const host = React.useContext(RightPaneHostContext);
  const docked = useDocked(width);
  const isOpen = useRightPane((state) => state.active === id);
  const close = useRightPane((state) => state.close);
  const titleId = React.useId();

  // A pane that leaves while open takes its fold with it; the sidebar would otherwise
  // stay on its rail beside nothing.
  React.useEffect(
    () => (): void => {
      if (useRightPane.getState().active === id) useRightPane.getState().close();
    },
    [id]
  );

  const [pane, setPane] = React.useState<HTMLElement | null>(null);
  const dismiss = React.useCallback((): void => {
    close();
    onClose();
  }, [close, onClose]);

  // Focus moves in as the pane opens, so Escape and the keyboard reach it at once.
  React.useEffect(() => {
    pane?.focus({ preventScroll: true });
  }, [pane]);

  // Escape dismisses the pane from anywhere inside it; a listener on the pane itself, so
  // an Escape meant for a menu or dialog elsewhere never reaches it.
  React.useEffect(() => {
    if (pane === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') dismiss();
    };
    pane.addEventListener('keydown', onKeyDown);
    return (): void => {
      pane.removeEventListener('keydown', onKeyDown);
    };
  }, [pane, dismiss]);

  const shown = isOpen && host !== null;

  // Published as the pane shows, in a layout effect, so the sidebar folds or opens beside it in
  // the same paint.
  React.useLayoutEffect(() => {
    if (!shown) return;
    usePaneDockDecision.setState({ docked });
    return (): void => {
      usePaneDockDecision.setState({ docked: null });
    };
  }, [shown, docked]);

  // One restore for every form: closing returns focus to whatever opened the pane, once the
  // pane has left the page and dropped focus. It records the opener as the pane opens.
  const returnFocus = useOverlayFocusReturn(shown);
  const wasShown = React.useRef(shown);
  React.useEffect(() => {
    if (wasShown.current && !shown) returnFocus(new Event('close', { cancelable: true }));
    wasShown.current = shown;
  }, [shown, returnFocus]);

  if (!shown) return null;

  const titleText = (
    <>
      {title}
      {titleAside !== undefined && (
        <>
          {' '}
          <span className="text-muted-foreground font-sans text-sm font-medium">{titleAside}</span>
        </>
      )}
    </>
  );

  const fullscreenForm = phone === 'fullscreen' && !docked;

  const headAndBody = (
    <>
      <header className={headClass(head, docked)}>
        <div className="min-w-0 flex-1">
          {/* Inside the full-screen overlay this heading is the dialog's title and takes the
              overlay's own id, so no id is passed there, not even an undefined one, which would
              override it; the docked and sheet forms name their aside by `titleId`. */}
          <OverlayTitle {...(fullscreenForm ? {} : { id: titleId })} className={TITLE_CLASS[head]}>
            {titleText}
          </OverlayTitle>
        </div>
        <IconButton
          type="button"
          icon={X}
          hitArea="extend"
          aria-label={`Close ${title.toLowerCase()}`}
          onClick={dismiss}
        />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </>
  );

  // Where the pane does not dock, the full-screen form is the shared modal overlay, filling the
  // screen below 768 and a centred dialog from 768, where the overlay draws no full screen: it
  // holds focus inside, hides the rest of the page from assistive technology while leaving
  // live regions such as toasts announced, returns focus to its opener and closes on Escape.
  if (fullscreenForm) {
    return (
      <Overlay
        open
        // Rendered only while open and with no trigger, the overlay reports only a close.
        onOpenChange={dismiss}
        ariaLabel={title}
        phonePresentation="fullscreen"
        showCloseButton={false}
        // From 768 the overlay is a centred dialog with only a max-height, which leaves the
        // pane's `h-full` nothing to fill. A full-viewport height, clamped by that cap, gives it
        // a definite one, so the body scrolls between the head and any foot.
        className="md:h-dvh"
      >
        <div
          data-chrome=""
          {...(testId === undefined ? {} : { 'data-testid': testId })}
          className={cn('flex h-full flex-col', SURFACE_CLASS[surface])}
        >
          {headAndBody}
        </div>
      </Overlay>
    );
  }

  return createPortal(
    <aside
      ref={setPane}
      tabIndex={-1}
      aria-labelledby={titleId}
      data-chrome=""
      {...(testId === undefined ? {} : { 'data-testid': testId })}
      className={paneClass(surface, phone, width, docked)}
    >
      {phone === 'sheet' && (
        <div aria-hidden="true" data-sheet-handle="" className={handleClass(docked)} />
      )}
      {headAndBody}
    </aside>,
    host
  );
}
