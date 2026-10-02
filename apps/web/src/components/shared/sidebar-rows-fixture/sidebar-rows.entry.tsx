import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { SquarePen } from 'lucide-react';
import { SidebarActionRow } from '../sidebar-action-row';
import { SidebarSearchRow } from '../sidebar-search-row';
import './sidebar-rows.css';

/**
 * Real-browser fixture for `sidebar-rows.browser.test.ts`: the New chat and Search rows in
 * an 18rem sidebar column and a 3.5rem rail, laid out as the sidebar's action block draws
 * them, plus the trial sidebar's hintless Search and the field form. Each launcher carries
 * the row's literal id, so the page repeats it; the tests select rows by their column. The
 * query string sets
 * the theme (`theme=dark`), the text scale (`scale=141`) and the accessibility face
 * (`face=open-dyslexic`) the way the app's own classes do.
 *
 * Test infrastructure, not shipped runtime: it is served to a real browser and never
 * imported by the Node test process, so `apps/web/vitest.config.ts` excludes
 * `src/**\/*-fixture/**` from the coverage gate.
 */

const params = new URLSearchParams(globalThis.location.search);
const root = document.documentElement;
if (params.get('theme') === 'dark') root.classList.add('dark');
const scale = params.get('scale');
if (scale !== null) root.classList.add(`a11y-font-scale-${scale}`);
const face = params.get('face');
if (face !== null) {
  root.classList.add('a11y-font-override');
  root.style.setProperty('--a11y-font-family', `"${face}"`);
}

function noop(): void {
  /* the fixture measures the rows; nothing opens */
}

function MemberSearch(): React.JSX.Element {
  const [value, setValue] = useState('');
  return <SidebarSearchRow mode="field" label="Search members" value={value} onChange={setValue} />;
}

function Fixture(): React.JSX.Element {
  return (
    <div className="bg-background text-foreground flex h-full flex-wrap content-start gap-6">
      <aside
        id="panel"
        className="bg-sidebar text-sidebar-foreground border-sidebar-border flex w-72 flex-col gap-2 border-r px-3 pt-1 pb-3"
      >
        <SidebarActionRow icon={SquarePen} label="New chat" href="#" kbd="mod+shift+o" />
        <SidebarSearchRow mode="launcher" onOpen={noop} kbd="mod+k" />
      </aside>
      <aside
        id="rail"
        className="bg-sidebar text-sidebar-foreground border-sidebar-border flex w-14 flex-col items-center gap-2 border-r pt-1 pb-3"
      >
        <SidebarActionRow icon={SquarePen} label="New chat" href="#" kbd="mod+shift+o" collapsed />
        <SidebarSearchRow mode="launcher" onOpen={noop} kbd="mod+k" collapsed />
      </aside>
      <aside
        id="trial"
        className="bg-sidebar text-sidebar-foreground border-sidebar-border flex w-72 flex-col gap-2 border-r px-3 pt-1 pb-3"
      >
        <SidebarActionRow icon={SquarePen} label="New chat" href="#" kbd="mod+shift+o" />
        <SidebarSearchRow mode="launcher" onOpen={noop} />
        <div id="field">
          <MemberSearch />
        </div>
      </aside>
    </div>
  );
}

interface Box {
  width: number;
  height: number;
}

function requireElement(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`missing element ${selector}`);
  return element;
}

function box(selector: string): Box {
  const rect = requireElement(selector).getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

/**
 * Whether any hint in the column is drawn at all, found by its text so a hint counts
 * whatever element carries it; an element that is not displayed has no client rects.
 */
function hintShown(columnId: string): boolean {
  return [...requireElement(`#${columnId}`).querySelectorAll('*')].some(
    (element) =>
      [...element.childNodes].some(
        (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').includes('Ctrl')
      ) && element.getClientRects().length > 0
  );
}

function style(selector: string): { fontSize: string; fontWeight: string } {
  const computed = getComputedStyle(requireElement(selector));
  return { fontSize: computed.fontSize, fontWeight: computed.fontWeight };
}

function rootPx(): number {
  return Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
}

declare global {
  // Optional: unset until this script finishes running — the property the driving test
  // polls to know the fixture page has mounted.
  var __rows:
    | {
        box(selector: string): Box;
        hintShown(columnId: string): boolean;
        style(selector: string): { fontSize: string; fontWeight: string };
        rootPx(): number;
      }
    | undefined;
}

const reactRoot = createRoot(requireElement('#root'));
flushSync(() => {
  reactRoot.render(<Fixture />);
});

globalThis.__rows = { box, hintShown, style, rootPx };
