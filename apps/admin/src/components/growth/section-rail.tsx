import * as React from 'react';
import { cn, useHotkeys } from '@hushbox/ui';

/** One of the questions the screen answers, and the panels answering it. */
interface GrowthSectionDescriptor {
  /** The fragment the rail's link names, which is the section element's id. */
  readonly id: string;
  readonly heading: string;
  /** The question the section answers, stated beside its heading. */
  readonly question: string;
}

/**
 * The questions the screen is grouped by, in the order it draws them.
 *
 * One list rather than two: the rail's links and the sections themselves are
 * both drawn from it, so a section cannot exist without a link to it and a link
 * cannot point at a fragment no section carries.
 */
export const GROWTH_SECTIONS = [
  {
    id: 'conversion',
    heading: 'Conversion',
    question: 'How are we doing this week, and is it improving?',
  },
  {
    id: 'traffic',
    heading: 'Traffic',
    question: 'Where do visitors come from, where do they land, where do they go?',
  },
  { id: 'behaviour', heading: 'Behaviour', question: 'What do people do on the site?' },
  {
    id: 'attribution',
    heading: 'Attribution',
    question: 'Which campaigns and channels are working?',
  },
] as const satisfies readonly GrowthSectionDescriptor[];

/**
 * Which section a fragment names. Derived from the list rather than declared
 * beside it, so the screen's own map of section to panels is one the compiler
 * checks against the sections that exist.
 */
export type GrowthSectionId = (typeof GROWTH_SECTIONS)[number]['id'];

/** Where one section's top edge sits, against the top of the viewport. */
interface SectionTop {
  readonly id: string;
  readonly top: number;
}

/**
 * A section whose top edge is within this much of the line counts as having
 * reached it, so a fractional layout position does not leave the section the
 * reader is looking at unmarked.
 */
const REACHED_TOLERANCE = 1;

/**
 * Which section the reader is in: the last one whose top has reached the line
 * the sticky header leaves, or the first one while none has. Undefined only
 * when the page is drawing no sections at all, which is the state before the
 * first one has mounted.
 *
 * The end of the scroll range counts as reaching the last section, because the
 * page runs out of scroll while that section's top is still below the line: the
 * last screenful of the page holds the last section and part of the one before
 * it, so with nowhere further to scroll the reader is in the last one and its
 * top never passes the line.
 */
export function sectionAtLine(
  tops: readonly SectionTop[],
  line: number,
  atEnd: boolean
): string | undefined {
  if (atEnd) return tops.at(-1)?.id;
  let reached = tops[0]?.id;
  for (const section of tops) {
    if (section.top - line <= REACHED_TOLERANCE) reached = section.id;
  }
  return reached;
}

/** How much of the scroll range may be left and still count as its end. */
const SCROLL_END_TOLERANCE = 1;

/** As much of a scroll container as the end of its range is read from. */
interface ScrollRange {
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
}

/**
 * Whether the reader has scrolled through the whole of a range. A box whose
 * content fits it has no end to reach — every page is at the end of a range it
 * does not have, and the section the line has reached is the answer there.
 */
export function atScrollEnd(range: ScrollRange | null): boolean {
  if (range === null) return false;
  const scrollable = range.scrollHeight - range.clientHeight;
  return scrollable > SCROLL_END_TOLERANCE && range.scrollTop >= scrollable - SCROLL_END_TOLERANCE;
}

/**
 * What the rail scrolls inside: its nearest ancestor that takes the overflow,
 * or the document's own scroller where no ancestor does. Found rather than
 * named, because the element that scrolls belongs to the shell this screen
 * mounts inside rather than to the screen.
 *
 * Hidden coupling to the shell: the walk stops at the first ancestor taking the
 * overflow, which today is the `main` element in
 * `apps/admin/src/routes/__root.tsx`. A shell that puts a second overflow
 * container anywhere between that one and this rail silently changes both the
 * range the end-of-page branch reads and the scrollport the anchor line is
 * resolved into, with nothing failing to say so.
 */
function scrollingAncestor(rail: HTMLElement): Element | null {
  for (let node = rail.parentElement; node !== null; node = node.parentElement) {
    const { overflowY } = globalThis.getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
  }
  return document.scrollingElement;
}

/**
 * Where the scrollport a jump is resolved against starts, in viewport
 * coordinates. An element's scrollport is its padding box, so it starts inside
 * the element's top border; the document's own scroller has the viewport for
 * its scrollport, so its start is the viewport's top however far the page is
 * scrolled — and its box, which has moved up by exactly that far, is not what a
 * jump is resolved against.
 */
function scrollportTop(scroller: Element | null): number {
  if (scroller === null || scroller === document.scrollingElement) return 0;
  return scroller.getBoundingClientRect().top + scroller.clientTop;
}

/** One read of where the page is: the line, and where each section sits. */
interface PageReading {
  /**
   * The line the rail's own bottom edge leaves, in viewport coordinates: a
   * section is under the header until its top passes this. Read off the rail
   * itself rather than from a height written down somewhere, because the header
   * above it wraps and grows under the font-scaling tiers. Floored at the start
   * of the scrollport, which is where the rail's edge stops meaning anything:
   * below the breakpoint that pins the header the rail scrolls out of view
   * entirely, and a section resting at the top of the scrollport has reached
   * the line, where flooring at the viewport's top would leave it short by
   * however far the scrollport starts below that.
   */
  readonly line: number;
  /**
   * The same line in the scroll container's coordinates, which is the space
   * `scroll-margin-top` is resolved in: the viewport line less the scrollport's
   * own offset from the viewport top. Never negative, because the line it comes
   * from is floored at that same offset.
   */
  readonly anchorLine: number;
  readonly tops: readonly SectionTop[];
  /** Whether the page has no scroll left, which reaches the last section. */
  readonly atEnd: boolean;
}

/**
 * Where the rail and the sections sit right now. A reading taken with no rail
 * on the page has no line and no sections, which is the reading that marks
 * nothing: there is nothing yet to be inside.
 */
export function pageReading(rail: HTMLElement | null): PageReading {
  if (rail === null) return { line: 0, anchorLine: 0, tops: [], atEnd: false };
  const scroller = scrollingAncestor(rail);
  const scrollportStart = scrollportTop(scroller);
  const line = Math.max(scrollportStart, rail.getBoundingClientRect().bottom);
  return {
    line,
    anchorLine: line - scrollportStart,
    tops: GROWTH_SECTIONS.flatMap((section) => {
      const element = document.querySelector(`#${section.id}`);
      return element === null ? [] : [{ id: section.id, top: element.getBoundingClientRect().top }];
    }),
    atEnd: atScrollEnd(scroller),
  };
}

/** How far a jumped-to section holds itself clear of the header above it. */
const ANCHOR_LINE_PROPERTY = '--growth-anchor-line';

/**
 * The rail under the toolbar: one link per section, the current one derived
 * from where the page is scrolled to.
 *
 * The links are ordinary anchors, so the browser does the scrolling and records
 * the position in the URL, and a reader who arrives on a fragment lands where
 * the link says. Which link is current is derived on every scroll and held
 * nowhere else: no hash is written, nothing is remembered between loads, so it
 * cannot disagree with where the page actually is. The number beside each label
 * is the key that reaches it.
 */
export function GrowthSectionRail(): React.JSX.Element {
  const railRef = React.useRef<HTMLElement>(null);
  const linksRef = React.useRef<(HTMLAnchorElement | null)[]>([]);
  const [current, setCurrent] = React.useState<string | undefined>();

  const derive = React.useCallback(() => {
    const { line, anchorLine, tops, atEnd } = pageReading(railRef.current);
    // Two coordinate spaces, from one measurement of the same edge. The
    // sections take this as `scroll-margin-top`, which the browser resolves
    // against the scrollport of the container they scroll in, so what is
    // published is `anchorLine` — the line already in that space. The mark is
    // derived from `line`, which is in the viewport space the sections' own
    // tops are read in. Publishing the viewport value instead lands every jump
    // the container's offset from the viewport below the line the mark is
    // derived from, which is what it did before.
    document.documentElement.style.setProperty(ANCHOR_LINE_PROPERTY, `${String(anchorLine)}px`);
    setCurrent(sectionAtLine(tops, line, atEnd));
  }, []);

  React.useEffect(() => {
    derive();
    // Again whenever the header the rail sits in changes size, for as long as
    // the rail is mounted. The header grows when its reads answer, which moves
    // the rail down without resizing the rail, and nothing else re-derives
    // until a scroll, resize or click, so the published line would sit under
    // the header by however much it grew. Hidden coupling: the header is the
    // rail's parent element, the sticky group in
    // `apps/admin/src/components/growth/growth-screen.tsx`. Not motion-gated,
    // because this is a layout reading rather than an animation.
    const header = new ResizeObserver(derive);
    const group = railRef.current?.parentElement;
    if (group !== null && group !== undefined) header.observe(group);
    // Captured, because a scroll event does not bubble and the element that
    // scrolls is the shell's, not this one's.
    document.addEventListener('scroll', derive, { capture: true, passive: true });
    globalThis.addEventListener('resize', derive);
    return () => {
      header.disconnect();
      document.removeEventListener('scroll', derive, { capture: true });
      globalThis.removeEventListener('resize', derive);
      document.documentElement.style.removeProperty(ANCHOR_LINE_PROPERTY);
    };
  }, [derive]);

  useHotkeys(
    GROWTH_SECTIONS.map((section, index) => ({
      combo: String(index + 1),
      description: `Jump to ${section.heading}`,
      onTrigger: () => {
        // The key presses the link rather than scrolling, so the shortcut and
        // the pointer take one path and both leave the URL naming the section.
        linksRef.current[index]?.click();
      },
    }))
  );

  return (
    <nav
      ref={railRef}
      data-slot="growth-section-rail"
      data-chrome=""
      aria-label="Growth sections"
      className="flex flex-wrap items-center gap-x-1 px-4"
    >
      {GROWTH_SECTIONS.map((section, index) => (
        <a
          key={section.id}
          ref={(element) => {
            linksRef.current[index] = element;
          }}
          href={`#${section.id}`}
          // The reader is inside one page, so what is marked is a place in it
          // rather than a page among several.
          aria-current={current === section.id ? 'location' : undefined}
          aria-keyshortcuts={String(index + 1)}
          // Measured again as the link is pressed, because the header above the
          // rail grows and shrinks with what the toolbar has to say and neither
          // a scroll nor a resize need have happened since. The jump runs after
          // this, so it reads a line taken now.
          onClick={derive}
          className={cn(
            // Inset, because the toolbar pinned above the rail paints over the
            // band just above each link, where an outer ring's top edge falls.
            'focus-visible:ring-ring flex items-center gap-1.5 border-b-2 border-transparent px-2 py-1.5 text-xs focus-visible:ring-2 focus-visible:outline-hidden focus-visible:ring-inset',
            current === section.id
              ? 'border-primary text-foreground font-semibold'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <span aria-hidden="true" className="font-mono text-[0.6875rem]">
            {index + 1}
          </span>
          {section.heading}
        </a>
      ))}
      <span className="text-muted-foreground ml-auto py-1.5 text-xs">
        Press a number to jump to a section
      </span>
    </nav>
  );
}

/**
 * One question's worth of the screen: a heading, the question it answers, and
 * the panels that answer it. A landmark, so the rail's links and the landmarks
 * navigator reach the same four places.
 */
export function GrowthSection({
  section,
  children,
}: Readonly<{
  readonly section: GrowthSectionDescriptor;
  readonly children: React.ReactNode;
}>): React.JSX.Element {
  const headingId = `${section.id}-heading`;
  return (
    <section
      id={section.id}
      aria-labelledby={headingId}
      // The room is held only where the header above is pinned, behind the same
      // `md` breakpoint that pins it in
      // `apps/admin/src/components/growth/growth-screen.tsx`. Below it nothing
      // stays in view for a jumped-to heading to clear, so the reserved room
      // would push the heading down past a header that is not there. One
      // breakpoint spelling on both, so the two cannot disagree about where the
      // chrome becomes pinned.
      className="flex flex-col gap-2 md:[scroll-margin-top:var(--growth-anchor-line,0px)]"
    >
      <header className="flex flex-wrap items-baseline gap-x-2">
        {/*
          The body ink rather than the brand red every h1-h6 inherits: at this
          size the WCAG large-text allowance does not apply, and the red clears
          3.56:1 on the light surface against a 4.5:1 floor.
        */}
        <h2 id={headingId} className="text-foreground text-[1.02rem] font-semibold">
          {section.heading}
        </h2>
        <p className="text-muted-foreground text-xs">{section.question}</p>
      </header>
      {children}
    </section>
  );
}
