import { PageBody } from '../../shared/page-body';
import { UsageFilters } from '../usage-filters';
import { renderFixture } from '../usage-fixture/usage-fixture';
import './usage-filters.css';

/**
 * Real-browser fixture for `usage-filters.browser.test.ts`: the usage page's filter row in
 * the page body's own column. The query string sets the text scale (`scale=141`) the way
 * the accessibility widget's class does.
 *
 * Test infrastructure, not shipped runtime: it is served to a real browser and never
 * imported by the Node test process, so `apps/web/vitest.config.ts` excludes
 * `src/**\/*-fixture/**` from the coverage gate.
 */

const scale = new URLSearchParams(globalThis.location.search).get('scale');
if (scale !== null) document.documentElement.classList.add(`a11y-font-scale-${scale}`);

function noop(): void {
  /* the fixture measures the row; nothing changes state */
}

interface Rect {
  left: number;
  right: number;
  top: number;
}

function rectOf(element: Element): Rect {
  const { left, right, top } = element.getBoundingClientRect();
  return { left, right, top };
}

/** The filter row's box and each range button's box, as laid out. */
function measure(): { row: Rect; buttons: Rect[] } {
  const group = document.querySelector('[role="group"]');
  if (group === null) throw new Error('missing the range group');
  const row = group.parentElement;
  if (row === null) throw new Error('missing the filter row');
  return {
    row: rectOf(row),
    buttons: [...group.querySelectorAll('button')].map((button) => rectOf(button)),
  };
}

declare global {
  var __filters: { measure: typeof measure } | undefined;
}

renderFixture(
  <PageBody>
    <UsageFilters
      range="30d"
      onRangeChange={noop}
      model={undefined}
      onModelChange={noop}
      availableModels={['anthropic/claude-sonnet-4.5']}
    />
  </PageBody>
);
globalThis.__filters = { measure };
