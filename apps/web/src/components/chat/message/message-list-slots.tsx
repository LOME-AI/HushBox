import { Children, Component, forwardRef, useCallback, useLayoutEffect, useRef } from 'react';

const FOOTER_HEIGHT = '10dvh';

/** What the list hands Virtuoso's `Header`, `Footer`, `List` and `Scroller`, which read it on every render. */
export interface ListContext {
  threadHeader: React.ReactNode;
  /** Content under the thread's last row, above its closing spacer, scrolling with the messages. */
  threadFooter: React.ReactNode;
  /** Whether the thread is revealed: its rows shown, and the scroller placed where it opens. */
  placed: boolean;
  /**
   * Called with how many rows it holds on every render in which Virtuoso shows its rows, which it
   * holds hidden until placed.
   */
  onRowsShown: (count: number) => void;
}

// Virtuoso hides its item list (the `visibility` in the style it hands `List`) until the row it
// opens at reaches its final place, but not the header and footer around it, which paint at the
// top and move as rows land. The whole scroller stays hidden until that placement, and then until
// the scroller is at the thread's end, or its scroll has come to rest short of it, where later
// row measurements can still move it. A thread with a heading opens at its top, where nothing
// above it can move. Virtuoso's first render there holds only its seed row, and the footer below
// it moves down as the other rows land, so that thread is shown once its rows run past the view,
// or every row is shown, or it first comes to rest.
const Scroller = forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { context: ListContext }
>(function Scroller({ context, ...props }, ref) {
  return (
    <div
      {...props}
      ref={ref}
      data-slot="scroll-area-viewport"
      className={context.placed ? undefined : 'invisible'}
    />
  );
});

interface HeldThroughCommitProps {
  /** The element whose height the commit must not shrink before it is done. */
  readonly target: React.RefObject<HTMLElement | null>;
  readonly children: React.ReactNode;
}

/**
 * Holds `target` at the height it was laid out at while React commits an update below it, and
 * lets it go once the commit is done. Virtuoso swaps its rows far down a thread, and the commit
 * removes the old rows before it inserts the new ones and moves the spacers; WebKit can lay the
 * page out in between, and a shorter list there clamps the scroll short of the thread's end,
 * where the thread then rests. A class because only `getSnapshotBeforeUpdate` runs before a
 * commit's DOM changes; the height is set outside React's style, which React's update leaves alone.
 */
export class HeldThroughCommit extends Component<HeldThroughCommitProps> {
  override getSnapshotBeforeUpdate(): null {
    const element = this.props.target.current;
    if (element !== null) element.style.minHeight = `${String(element.offsetHeight)}px`;
    return null;
  }

  override componentDidUpdate(): void {
    const element = this.props.target.current;
    if (element !== null) element.style.minHeight = '';
  }

  override render(): React.ReactNode {
    return this.props.children;
  }
}

const List = forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { context: ListContext }
>(function List({ context, ...props }, ref) {
  // A shown list can still hold no row for a frame, at a scroll set from estimated heights.
  const rowCount = Children.count(props.children);
  const rowsShown = props.style?.visibility !== 'hidden' && rowCount > 0;
  const { onRowsShown } = context;
  const listRef = useRef<HTMLDivElement | null>(null);
  const setListRef = useCallback(
    (element: HTMLDivElement | null): void => {
      listRef.current = element;
      if (typeof ref === 'function') ref(element);
      else if (ref !== null) ref.current = element;
    },
    [ref]
  );
  // A layout effect, so the scroller is revealed in the same frame the rows land at the end. It
  // runs on every render: a render that moves the rows is where the scroll may have settled.
  useLayoutEffect(() => {
    if (rowsShown) onRowsShown(rowCount);
  });
  return (
    <HeldThroughCommit target={listRef}>
      <div {...props} ref={setListRef} />
    </HeldThroughCommit>
  );
});

const Footer = ({ context }: Readonly<{ context: ListContext }>): React.JSX.Element => (
  <>
    {context.threadFooter}
    <div style={{ height: FOOTER_HEIGHT }} aria-hidden="true" />
  </>
);

const Header = ({ context }: Readonly<{ context: ListContext }>): React.JSX.Element => (
  <>
    <div className="h-4" aria-hidden="true" />
    {context.threadHeader}
  </>
);

export const components = { Header, Footer, List, Scroller };
