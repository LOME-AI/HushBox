import * as React from 'react';

export interface PageStructureProps {
  /** When true, scans the container and shows the navigation list. */
  enabled: boolean;
  /** CSS selector for the root the scan should walk. Defaults to `'body'`. */
  containerSelector?: string;
  /** Optional className applied to the rendered `<nav>`. */
  className?: string;
}

interface StructureItem {
  /** Stable key used by React; unrelated to the target element's DOM id. */
  key: string;
  /** Visible label rendered inside the `<button>`. */
  label: string;
  /** Element tag name in upper-case (`'H2'`, `'MAIN'`, `'DIV'`, ...). */
  tagName: string;
  /** Heading level 1–6 for `<h1>`–`<h6>`; `0` for landmark elements. */
  level: number;
  /** Live reference to the target element so click handlers can scroll/focus it. */
  element: HTMLElement;
}

const QUERY_SELECTOR = [
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'main',
  'nav',
  'aside',
  '[role=main]',
  '[role=navigation]',
  '[role=complementary]',
  '[role=region][aria-label]',
].join(', ');

const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

const FOCUSABLE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);

const DEBOUNCE_MS = 150;

const MAX_LABEL_CHARS = 60;

const LANDMARK_NAMES: Record<string, string> = {
  MAIN: 'Main content',
  NAV: 'Navigation',
  ASIDE: 'Sidebar',
};

function levelFor(element: HTMLElement): number {
  const tag = element.tagName;
  if (!HEADING_TAGS.has(tag)) return 0;
  return Number.parseInt(tag.slice(1), 10);
}

function isInsideAriaHidden(element: HTMLElement): boolean {
  return element.closest('[aria-hidden="true"]') !== null;
}

function isInsideOwnWidget(element: HTMLElement): boolean {
  return element.closest('[data-a11y-page-structure]') !== null;
}

function truncate(text: string): string {
  const trimmed = text.trim().replaceAll(/\s+/g, ' ');
  return trimmed.length > MAX_LABEL_CHARS ? `${trimmed.slice(0, MAX_LABEL_CHARS - 1)}…` : trimmed;
}

function labelFor(element: HTMLElement): string {
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel !== null && ariaLabel.length > 0) return truncate(ariaLabel);

  // For headings, the text content IS the label (and is short).
  if (HEADING_TAGS.has(element.tagName)) {
    const text = truncate(element.textContent);
    if (text.length > 0) return text;
  }

  // For landmarks, use a friendly name — never the full textContent (which would
  // include the entire region's text).
  const friendly = LANDMARK_NAMES[element.tagName];
  if (friendly !== undefined) return friendly;

  const role = element.getAttribute('role');
  if (role !== null && role.length > 0) {
    return role.charAt(0).toUpperCase() + role.slice(1);
  }

  return element.tagName.toLowerCase();
}

function newItemKey(): string {
  return globalThis.crypto.randomUUID();
}

function collectStructureItems(root: ParentNode): StructureItem[] {
  const candidates = root.querySelectorAll<HTMLElement>(QUERY_SELECTOR);
  const items: StructureItem[] = [];
  for (const element of candidates) {
    if (isInsideAriaHidden(element)) continue;
    if (isInsideOwnWidget(element)) continue;
    if (element.offsetParent === null) continue;
    items.push({
      key: newItemKey(),
      label: labelFor(element),
      tagName: element.tagName,
      level: levelFor(element),
      element,
    });
  }
  return items;
}

function isFocusableTarget(element: HTMLElement): boolean {
  if (element.hasAttribute('tabindex')) return true;
  return FOCUSABLE_TAGS.has(element.tagName);
}

function focusTarget(element: HTMLElement): void {
  if (!isFocusableTarget(element)) {
    element.setAttribute('tabindex', '-1');
  }
  element.focus({ preventScroll: true });
}

function activateItem(element: HTMLElement): void {
  if (element.id.length === 0) {
    element.id = newItemKey();
  }
  element.scrollIntoView({ behavior: 'smooth', block: 'start' });
  focusTarget(element);
}

function resolveContainer(selector: string): ParentNode | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector(selector);
}

interface RefreshSchedulerOptions {
  container: ParentNode;
  setItems: (items: StructureItem[]) => void;
}

function createRefreshScheduler({ container, setItems }: RefreshSchedulerOptions): {
  trigger: () => void;
  cancel: () => void;
} {
  let handle: ReturnType<typeof setTimeout> | null = null;
  const trigger = (): void => {
    if (handle !== null) globalThis.clearTimeout(handle);
    handle = globalThis.setTimeout(() => {
      handle = null;
      setItems(collectStructureItems(container));
    }, DEBOUNCE_MS);
  };
  const cancel = (): void => {
    if (handle !== null) {
      globalThis.clearTimeout(handle);
      handle = null;
    }
  };
  return { trigger, cancel };
}

interface UsePageStructureOptions {
  enabled: boolean;
  containerSelector: string;
}

function usePageStructure({
  enabled,
  containerSelector,
}: UsePageStructureOptions): StructureItem[] {
  const [items, setItems] = React.useState<StructureItem[]>([]);

  React.useEffect(() => {
    if (!enabled) {
      setItems([]);
      return;
    }
    const container = resolveContainer(containerSelector);
    if (!container) {
      setItems([]);
      return;
    }

    setItems(collectStructureItems(container));
    const { trigger, cancel } = createRefreshScheduler({ container, setItems });
    const observer = new MutationObserver(trigger);
    observer.observe(container as Node, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-hidden', 'aria-label', 'role'],
    });

    return () => {
      observer.disconnect();
      cancel();
    };
  }, [enabled, containerSelector]);

  return items;
}

/**
 * PageStructure — lists every heading and ARIA landmark in the current page,
 * letting the user jump to any of them. Mounted at the app root and gated
 * by a single boolean prop. The widget itself is purely additive: it never
 * mutates the page beyond assigning a stable `id` to anonymous targets and
 * a `tabindex="-1"` to non-focusable ones (only when the user clicks them).
 */
export function PageStructure({
  enabled,
  containerSelector = 'body',
  className,
}: Readonly<PageStructureProps>): React.JSX.Element | null {
  const items = usePageStructure({ enabled, containerSelector });

  if (!enabled) return null;

  const navClasses = [
    'bg-background text-foreground border-border fixed top-4 right-4 z-[9998] max-h-[calc(100dvh-2rem)] w-72 overflow-y-auto rounded-lg border p-2 text-sm leading-tight shadow-lg',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <nav aria-label="Page outline" data-a11y-page-structure="" className={navClasses}>
      <div className="text-foreground/60 px-2 pb-2 text-xs font-semibold">Page outline</div>
      <ul className="m-0 list-none p-0">
        {items.map((item) => (
          <li key={item.key}>
            <button
              type="button"
              data-tag={item.tagName}
              data-level={String(item.level)}
              onClick={() => {
                activateItem(item.element);
              }}
              className="hover:bg-accent block w-full rounded px-2 py-1 text-left"
              style={{ paddingLeft: `${String(8 + Math.max(0, item.level - 1) * 12)}px` }}
            >
              {item.label}
            </button>
          </li>
        ))}
        {items.length === 0 && (
          <li className="text-foreground/50 px-2 py-1">No headings or landmarks found.</li>
        )}
      </ul>
    </nav>
  );
}
