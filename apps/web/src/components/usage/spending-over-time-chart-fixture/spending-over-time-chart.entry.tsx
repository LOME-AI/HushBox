import { TEST_IDS, type SpendingOverTimeResponse } from '@hushbox/shared';
import { PageBody } from '../../shared/page-body';
import { SpendingOverTimeChart } from '../spending-over-time-chart';
import { UsageModelSet } from '../use-usage-model-labels';
import { backgroundBehind, renderFixture } from '../usage-fixture/usage-fixture';
import { FIXTURE_PERIODS } from './fixture-periods';
import { FIXTURE_MODEL_NAMES } from './models-stub';
import './spending-over-time-chart.css';

/**
 * Real-browser fixture for `spending-over-time-chart.browser.test.ts`: the usage page's
 * spending chart with fourteen long-named models, between a block before it and a block
 * after it, in the page body's own column. The query string sets the text scale
 * (`scale=141`) the way the accessibility widget's class does, and the theme (`theme=dark`)
 * the way the theme toggle's class does.
 *
 * Test infrastructure, not shipped runtime: it is served to a real browser and never
 * imported by the Node test process, so `apps/web/vitest.config.ts` excludes
 * `src/**\/*-fixture/**` from the coverage gate.
 */

const scale = new URLSearchParams(globalThis.location.search).get('scale');
if (scale !== null) document.documentElement.classList.add(`a11y-font-scale-${scale}`);
const theme = new URLSearchParams(globalThis.location.search).get('theme');
document.documentElement.classList.toggle('dark', theme === 'dark');

const MODEL_IDS = FIXTURE_MODEL_NAMES.map(([id]) => id);
const DATA: SpendingOverTimeResponse = {
  data: FIXTURE_PERIODS.flatMap((period, day) =>
    MODEL_IDS.map((model, index) => ({
      period,
      model,
      totalCost: String((index + 1) * 10_000_000 * ((day % 5) + 1)),
      count: 1,
    }))
  ),
};

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  height: number;
}

function rectOf(element: Element): Rect {
  const { left, right, top, bottom, height } = element.getBoundingClientRect();
  return { left, right, top, bottom, height };
}

function required(selector: string): Element {
  const element = document.querySelector(selector);
  if (element === null) throw new Error(`missing ${selector}`);
  return element;
}

interface Label {
  text: string;
  left: number;
  right: number;
}

/** Each date the x-axis prints, with its box, left to right. */
function xLabels(): Label[] {
  return [...document.querySelectorAll('[data-chart] .recharts-xAxis-tick-labels text')]
    .map((label) => {
      const { left, right } = label.getBoundingClientRect();
      return { text: label.textContent, left, right };
    })
    .toSorted((a, b) => a.left - b.left);
}

interface AxisFigure {
  axis: 'x' | 'y';
  text: string;
  fill: string;
  background: string;
}

/** Every figure both axes print, with its computed fill and the colour it is drawn over. */
function axisFigures(): AxisFigure[] {
  return (['x', 'y'] as const).flatMap((axis) =>
    [...document.querySelectorAll(`[data-chart] .recharts-${axis}Axis-tick-labels text`)].map(
      (figure) => ({
        axis,
        text: figure.textContent,
        fill: getComputedStyle(figure).fill,
        background: backgroundBehind(figure),
      })
    )
  );
}

/** Sets the widget's text step on the page as it is, the way changing it in the widget does. */
function setScale(step: string): void {
  document.documentElement.classList.add(`a11y-font-scale-${step}`);
}

/** The chart's block, its plot and the span of its y-axis figures, its legend and each entry, the x-axis dates, and the blocks around it. */
function measure(): {
  before: Rect;
  block: Rect;
  plot: Rect;
  yAxis: Rect;
  legend: Rect;
  entries: Rect[];
  after: Rect;
  xLabels: Label[];
  pageOverflow: number;
} {
  const block = required(`[data-testid="${TEST_IDS.spendingOverTimeChart}"]`);
  const legend = required('ul[aria-label="Legend"]');
  return {
    before: rectOf(required('#block-before')),
    block: rectOf(block),
    plot: rectOf(required('[data-chart]')),
    yAxis: rectOf(required('[data-chart] .recharts-yAxis-tick-labels')),
    legend: rectOf(legend),
    entries: [...legend.querySelectorAll('li')].map((entry) => rectOf(entry)),
    after: rectOf(required('#block-after')),
    xLabels: xLabels(),
    pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
}

declare global {
  var __chart:
    | {
        measure: typeof measure;
        xLabels: typeof xLabels;
        axisFigures: typeof axisFigures;
        setScale: typeof setScale;
      }
    | undefined;
}

renderFixture(
  <PageBody className="flex flex-col gap-8">
    <UsageModelSet value={MODEL_IDS}>
      <p id="block-before">Total Spent</p>
      <SpendingOverTimeChart data={DATA} isLoading={false} />
      <p id="block-after">Cost by Model</p>
    </UsageModelSet>
  </PageBody>
);

globalThis.__chart = { measure, xLabels, axisFigures, setScale };
