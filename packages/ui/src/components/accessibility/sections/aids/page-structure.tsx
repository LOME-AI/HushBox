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

function labelFor(element: HTMLElement): string {
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel !== null && ariaLabel.length > 0) return ariaLabel;
  const trimmed = element.textContent.trim();
  if (trimmed.length > 0) return trimmed;
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

  return (
    <nav aria-label="Page structure" data-a11y-page-structure="" className={className}>
      <ul>
        {items.map((item) => (
          <li key={item.key}>
            <button
              type="button"
              data-tag={item.tagName}
              data-level={String(item.level)}
              onClick={() => {
                activateItem(item.element);
              }}
            >
              {item.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
