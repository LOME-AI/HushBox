import * as React from 'react';

import { cn } from '../../lib/utilities';
import { Search, X } from '../../doors/icons';
import { IconButton } from '../button/icon-button';
import { TextField } from '../field/text-field';
import { Icon, type IconComponent, type IconGlyphProps } from '../icons/icon';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../primitives/dialog';
import { Input } from '../primitives/input';
import { Overlay } from '../overlay/overlay';
import { OverlayContent } from '../overlay/overlay-content';
import { useOverlayFocusReturn } from '../overlay/overlay-focus-return';
import { Img } from './img';
import { Kbd } from './kbd';
import { LOGO_FALLBACK_SRC, resolveImageSrc as resolveImageSource } from './logo';
import logoUrl from '../../assets/HushBoxLogo.png';

export interface PaletteItem {
  readonly id: string;
  readonly label: string;
  /** Secondary text shown right-aligned in the row, and matched by the search. */
  readonly hint?: string;
  /** The product appearance draws it in a tile before the label. */
  readonly icon?: IconComponent;
  /** The product appearance shows it at the row's end, in place of the hint. */
  readonly meta?: React.ReactNode;
}

export interface PaletteSection<TItem extends PaletteItem = PaletteItem> {
  readonly heading: string;
  readonly items: readonly TItem[];
}

interface BuildSectionsOptions<TItem extends PaletteItem> {
  /** Raw input value; trimmed and lowercased before matching. */
  readonly query: string;
  readonly groups: readonly PaletteSection<TItem>[];
  /** Shown above the groups while the query is empty. */
  readonly recents?: readonly TItem[];
  /** A section appended to every non-empty query, e.g. "go to whatever was typed". */
  readonly fallback?: (query: string) => PaletteSection<TItem>;
}

function matches(item: PaletteItem, query: string): boolean {
  const haystack = `${item.label} ${item.hint ?? ''}`.toLowerCase();
  return haystack.includes(query);
}

function sectionWithout<TItem extends PaletteItem>(
  heading: string,
  items: readonly TItem[],
  top: TItem | undefined
): readonly PaletteSection<TItem>[] {
  const rest = items.filter((item) => item !== top);
  return rest.length > 0 ? [{ heading, items: rest }] : [];
}

/**
 * The palette's sections for a query: recents and the full groups while empty,
 * otherwise the matches with the first one promoted to its own top-result
 * section. Pure — callers own where the items come from.
 */
export function buildSections<TItem extends PaletteItem>({
  query,
  groups,
  recents,
  fallback,
}: BuildSectionsOptions<TItem>): readonly PaletteSection<TItem>[] {
  const normalized = query.trim().toLowerCase();
  if (normalized === '') {
    const recentItems = recents ?? [];
    return [
      ...(recentItems.length > 0 ? [{ heading: 'Recents', items: recentItems }] : []),
      ...groups,
    ];
  }
  const matched = groups.map((group) => ({
    heading: group.heading,
    items: group.items.filter((item) => matches(item, normalized)),
  }));
  const top = matched.find((group) => group.items.length > 0)?.items[0];
  return [
    ...(top === undefined ? [] : [{ heading: 'Top result', items: [top] }]),
    ...matched.flatMap((group) => sectionWithout(group.heading, group.items, top)),
    ...(fallback === undefined ? [] : [fallback(normalized)]),
  ];
}

type PaletteAppearance = 'product' | 'plain';

/** Where key hints are hidden: phone widths and touch pointers, the rule `Kbd` hides by. */
const SHOWN_WITHOUT_HINTS = 'hidden max-md:inline-flex pointer-coarse:inline-flex';
const HIDDEN_WITHOUT_HINTS = 'max-md:hidden pointer-coarse:hidden';

// The product panel fits under the top placement (its 88dvh less the dialog's top padding),
// so at large text the list shrinks and scrolls while the field and footer stay in view.
const PANEL_CLASS: Readonly<Record<PaletteAppearance, string>> = {
  product: 'max-h-[calc(88dvh-1.5rem)] max-w-160 gap-0 overflow-hidden p-0',
  plain: 'top-24 translate-y-0 gap-0 p-0',
};

const LIST_CLASS: Readonly<Record<PaletteAppearance, string>> = {
  product: 'min-h-0 flex-1 overflow-y-auto px-2 pt-0.5 pb-2 md:max-h-[min(36rem,72dvh)]',
  plain: 'max-h-80 overflow-y-auto p-1',
};

const HEADING_CLASS: Readonly<Record<PaletteAppearance, string>> = {
  product:
    "text-brand-red flex items-center gap-3 px-2 pt-3.5 pb-1.5 font-serif text-sm leading-tight font-bold after:flex-1 after:border-t after:border-border after:content-['']",
  plain: 'text-muted-foreground px-2 pt-2 pb-1 text-xs font-medium uppercase',
};

/** The search glyph the field draws, in the brand red the palette's field carries. */
function SearchGlyph({ className, ...props }: Readonly<IconGlyphProps>): React.JSX.Element {
  return <Search {...props} className={cn(className, 'text-brand-red')} />;
}

function Wordmark(): React.JSX.Element {
  return (
    <span className="text-ui-sm ml-auto inline-flex items-center gap-1.5 font-serif font-bold">
      <Img
        src={resolveImageSource(logoUrl) || LOGO_FALLBACK_SRC}
        alt=""
        className="size-4 object-contain"
      />
      <span>
        Hush<span className="text-brand-red">Box</span>
      </span>
    </span>
  );
}

function KeyLegend(): React.JSX.Element {
  return (
    <>
      <span className="inline-flex items-center gap-1.5">
        <Kbd combo="↑" form="keycaps" />
        <Kbd combo="↓" form="keycaps" />
        Move
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Kbd combo="Enter" form="keycaps" />
        Open
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Kbd combo="Esc" form="keycaps" />
        Close
      </span>
      <Wordmark />
    </>
  );
}

interface PaletteRowProps<TItem extends PaletteItem> {
  readonly item: TItem;
  readonly selected: boolean;
}

function ProductRow<TItem extends PaletteItem>({
  item,
  selected,
}: PaletteRowProps<TItem>): React.JSX.Element {
  const meta = item.meta ?? item.hint;
  return (
    <>
      {item.icon === undefined ? null : (
        <span
          className={cn(
            'grid size-7.5 shrink-0 place-items-center rounded-md',
            selected
              ? 'bg-brand-red text-primary-foreground'
              : 'bg-background-subtle text-muted-foreground'
          )}
        >
          <Icon icon={item.icon} />
        </span>
      )}
      <span className="min-w-0 flex-1 truncate font-medium">{item.label}</span>
      {meta === undefined ? null : (
        <span className="text-muted-foreground inline-flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap">
          {meta}
        </span>
      )}
      {selected ? <Kbd combo="Enter" form="keycaps" aria-hidden /> : null}
    </>
  );
}

function PlainRow<TItem extends PaletteItem>({ item }: PaletteRowProps<TItem>): React.JSX.Element {
  return (
    <>
      {/* The label yields width and the hint never does: a hint is an
          id the reader scans by, and a shrunk one breaks mid-token. */}
      <span className="min-w-0">{item.label}</span>
      {item.hint === undefined ? null : (
        <span className="text-muted-foreground shrink-0 font-mono text-xs">{item.hint}</span>
      )}
    </>
  );
}

const ROW_CLASS: Readonly<Record<PaletteAppearance, { base: string; selected: string }>> = {
  product: {
    base: 'flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2.5 py-1.5 text-sm max-md:min-h-12',
    selected: 'bg-brand-red-subtle',
  },
  plain: {
    base: 'flex cursor-pointer items-center justify-between rounded-md px-2 py-1.5 text-sm',
    selected: 'bg-accent text-accent-foreground',
  },
};

/**
 * The keyboard-first launcher. Owns the query, the shared keyboard/hover
 * selection and the combobox wiring; knows nothing about what the items do —
 * the caller supplies the sections for a query and runs the chosen item.
 *
 * The `product` appearance opens near the top of the viewport from 768px and
 * fills the screen below it, with the floating-label search, red serif section
 * heads, icon tiles and a key legend. `plain` keeps the operator tools' own
 * palette: its dialog, unadorned field and rows.
 */
export function CommandPalette<TItem extends PaletteItem>({
  open,
  onClose,
  sections,
  onRun,
  empty,
  footer,
  appearance = 'product',
  title,
  description,
  placeholder,
  testId,
  inputTestId,
  optionTestId,
  className,
}: Readonly<{
  open: boolean;
  onClose: () => void;
  sections: (query: string) => readonly PaletteSection<TItem>[];
  onRun: (item: TItem) => void;
  /**
   * What the reader is told when the query leaves no item to run. Omitted, the
   * palette stays bare, which is what a caller whose sections always offer a
   * fallback row wants.
   */
  empty?: React.ReactNode;
  /**
   * The footer's content, drawn where key hints show. The product appearance
   * defaults to its key legend and wordmark; the plain one draws none.
   */
  footer?: React.ReactNode;
  appearance?: PaletteAppearance;
  /** Screen-reader heading for the dialog. */
  title: string;
  /** Screen-reader instructions: the search field's description, or the plain dialog's. */
  description: string;
  /** The search field's label, and its accessible name. */
  placeholder: string;
  testId: string;
  inputTestId: string;
  optionTestId: string;
  className?: string;
}>): React.JSX.Element {
  const [query, setQuery] = React.useState('');
  const [selected, setSelected] = React.useState(0);
  // Reset as `open` turns false, not inside `close()`: a caller's own toggle (a shortcut,
  // a store) closes the palette without `close()` running.
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) {
      setQuery('');
      setSelected(0);
    }
  }
  const domId = React.useId();
  const listboxId = `${domId}listbox`;
  const descriptionId = `${domId}description`;
  const inputRef = React.useRef<HTMLInputElement>(null);
  const product = appearance === 'product';
  const returnFocus = useOverlayFocusReturn(open);

  const rendered = sections(query);
  const flat = rendered.flatMap((section) => section.items);
  // Each section paired with its first item's flat-list index, so keyboard
  // selection and rendered options share one numbering.
  const sectionsWithOffset = rendered.map((section, index) => ({
    section,
    offset: rendered.slice(0, index).reduce((total, prior) => total + prior.items.length, 0),
  }));
  const selectedIndex = Math.min(selected, Math.max(flat.length - 1, 0));

  function close(): void {
    onClose();
  }

  function run(item: TItem): void {
    close();
    onRun(item);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelected((current) => Math.min(current + 1, flat.length - 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelected((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const item = flat[selectedIndex];
      if (item !== undefined) {
        run(item);
      }
    }
  }

  const combobox = {
    ref: inputRef,
    'data-testid': inputTestId,
    role: 'combobox',
    'aria-expanded': true,
    'aria-controls': listboxId,
    'aria-activedescendant': `${domId}${String(selectedIndex)}`,
    autoComplete: 'off',
    value: query,
    onChange: (event: React.ChangeEvent<HTMLInputElement>): void => {
      setQuery(event.target.value);
      setSelected(0);
    },
    onKeyDown: handleKeyDown,
  } as const;

  const legend = footer ?? (product ? <KeyLegend /> : undefined);

  const body = (
    <>
      {/* Before the listbox, which fills the phone form's height: drawn after it, the
          answer would land at the foot of the screen, away from the query it answers.
          Outside it: an explanation is not an option, and a listbox whose children are
          not options is one a screen reader cannot count. */}
      {flat.length === 0 ? empty : null}
      <div id={listboxId} role="listbox" aria-label={title} className={LIST_CLASS[appearance]}>
        {sectionsWithOffset.map(({ section, offset }) => (
          <section key={section.heading} aria-label={section.heading}>
            <h3 className={HEADING_CLASS[appearance]}>{section.heading}</h3>
            {section.items.map((item, itemIndex) => {
              const index = offset + itemIndex;
              const isSelected = index === selectedIndex;
              const Row = product ? ProductRow : PlainRow;
              return (
                <div
                  key={`${section.heading}-${item.id}`}
                  id={`${domId}${String(index)}`}
                  data-testid={optionTestId}
                  role="option"
                  aria-selected={isSelected}
                  className={cn(
                    ROW_CLASS[appearance].base,
                    isSelected && ROW_CLASS[appearance].selected
                  )}
                  onMouseEnter={() => {
                    setSelected(index);
                  }}
                  onClick={() => {
                    run(item);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      run(item);
                    }
                  }}
                  tabIndex={-1}
                >
                  <Row item={item} selected={isSelected} />
                </div>
              );
            })}
          </section>
        ))}
      </div>
      {legend === undefined ? null : (
        <footer
          aria-hidden
          className={cn(
            'text-muted-foreground flex items-center gap-5 overflow-hidden border-t px-4 py-2 text-xs whitespace-nowrap',
            HIDDEN_WITHOUT_HINTS
          )}
        >
          {legend}
        </footer>
      )}
    </>
  );

  if (!product) {
    // The operator tools' palette keeps its own frame: a dialog at a fixed offset on an
    // unblurred scrim at every width, focusing its field on open whatever the pointer.
    return (
      <Dialog
        open={open}
        onOpenChange={() => {
          close();
        }}
      >
        <DialogContent
          data-testid={testId}
          showCloseButton={false}
          className={cn(PANEL_CLASS.plain, className)}
          onCloseAutoFocus={returnFocus}
        >
          <DialogTitle className="sr-only">{title}</DialogTitle>
          <DialogDescription className="sr-only">{description}</DialogDescription>
          <Input
            {...combobox}
            aria-label={placeholder}
            placeholder={placeholder}
            className="rounded-b-none border-0 border-b focus-visible:ring-0"
          />
          {body}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Overlay
      open={open}
      onOpenChange={() => {
        close();
      }}
      ariaLabel={title}
      showCloseButton={false}
      initialFocus={inputRef}
      phonePresentation="fullscreen"
    >
      <OverlayContent
        placement="top"
        size="lg"
        data-testid={testId}
        className={cn(PANEL_CLASS.product, className)}
      >
        <p id={descriptionId} className="sr-only">
          {description}
        </p>
        <div className="flex items-center gap-3 border-b px-3.5 pt-3.5 pb-1.5">
          <div className="min-w-0 flex-1">
            <TextField
              {...combobox}
              aria-describedby={descriptionId}
              label={placeholder}
              icon={SearchGlyph}
              suffix={<Kbd combo="Esc" form="keycaps" />}
              className="text-base"
            />
          </div>
          <IconButton icon={X} aria-label="Close" className={SHOWN_WITHOUT_HINTS} onClick={close} />
        </div>
        {body}
      </OverlayContent>
    </Overlay>
  );
}
