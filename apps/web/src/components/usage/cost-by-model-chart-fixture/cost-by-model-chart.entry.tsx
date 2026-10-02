import { TEST_IDS, type CostByModelResponse } from '@hushbox/shared';
import { CostByModelChart } from '../cost-by-model-chart';
import { UsageModelSet } from '../use-usage-model-labels';
import { backgroundBehind, renderFixture } from '../usage-fixture/usage-fixture';
import './cost-by-model-chart.css';

/**
 * Real-browser fixture for `cost-by-model-chart.browser.test.ts`: the usage page's Cost by
 * Model block at the width the page gives it, set by the query string (`block=288`), with a
 * wide top amount, long names, a model the catalog lacks and one model billed through two
 * providers. `scale=141` sets the text scale the way the accessibility widget's class does, and
 * `theme=dark` the theme the way the theme toggle's class does.
 *
 * Test infrastructure, not shipped runtime: it is served to a real browser and never
 * imported by the Node test process, so `apps/web/vitest.config.ts` excludes
 * `src/**\/*-fixture/**` from the coverage gate.
 */

const query = new URLSearchParams(globalThis.location.search);
const scale = query.get('scale');
if (scale !== null) document.documentElement.classList.add(`a11y-font-scale-${scale}`);
document.documentElement.classList.toggle('dark', query.get('theme') === 'dark');
const blockWidth = Number(query.get('block'));

function row(
  model: string,
  provider: string,
  totalCost: string
): CostByModelResponse['data'][number] {
  return { model, provider, totalCost, messageCount: 1, totalInputTokens: 1, totalOutputTokens: 1 };
}

const DATA: CostByModelResponse = {
  data: [
    row('fictional/opus', 'fictional', '123456789000'),
    row('fictional/sonnet', 'fictional', '17413320000'),
    row('fictional/unlisted-provider-model-with-a-long-id', 'fictional', '6581430000'),
    row('fictional/nano-30b', 'first-provider', '1104928750'),
    row('fictional/nano-30b', 'second-provider', '197546100'),
    row('fictional/mini', 'fictional', '35147650'),
    row('fictional/flash', 'fictional', '1757850'),
    row('fictional/ministral', 'fictional', '30250'),
  ],
};
const MODEL_IDS = [...new Set(DATA.data.map((entry) => entry.model))];

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function boxOf(element: Element): Box {
  const { left, right, top, bottom } = element.getBoundingClientRect();
  return { left, right, top, bottom };
}

function required(root: ParentNode, selector: string): Element {
  const element = root.querySelector(selector);
  if (element === null) throw new Error(`missing ${selector}`);
  return element;
}

interface Text {
  text: string;
  colour: string;
  background: string;
  large: boolean;
}

function textOf(element: Element): Text {
  const style = getComputedStyle(element);
  const size = Number.parseFloat(style.fontSize);
  const bold = Number.parseInt(style.fontWeight, 10) >= 700;
  return {
    text: element.textContent,
    colour: style.color,
    background: backgroundBehind(element),
    // WCAG's large text: 18pt, or 14pt bold.
    large: size >= 24 || (bold && size >= 18.66),
  };
}

interface Row {
  name: Box;
  nameText: string;
  nameClipped: boolean;
  track: Box;
  amount: Box;
  amountText: string;
}

function measure(): {
  block: Box;
  rows: Row[];
  texts: Text[];
  pageOverflow: number;
} {
  const block = required(document, `[data-testid="${TEST_IDS.costByModelChart}"]`);
  const rows = [...block.querySelectorAll('li')].map((item) => {
    const name = required(item, '[data-slot="bar-name"]');
    const nameText = required(name, ':scope > :last-child');
    const amount = required(item, '[data-slot="bar-amount"]');
    return {
      name: boxOf(name),
      nameText: nameText.textContent,
      nameClipped: nameText.scrollWidth > nameText.clientWidth,
      track: boxOf(required(item, '[data-slot="bar-track"]')),
      amount: boxOf(amount),
      amountText: amount.textContent,
    };
  });
  const texts = [
    required(block, 'h2'),
    ...block.querySelectorAll('[data-slot="bar-name"] > :last-child'),
    ...block.querySelectorAll('[data-slot="bar-amount"]'),
  ].map((element) => textOf(element));
  return {
    block: boxOf(block),
    rows,
    texts,
    pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
}

declare global {
  var __costByModel: { measure: typeof measure } | undefined;
}

renderFixture(
  <div className="mx-4" style={{ width: `${String(blockWidth)}px` }}>
    <UsageModelSet value={MODEL_IDS}>
      <CostByModelChart data={DATA} isLoading={false} />
    </UsageModelSet>
  </div>
);

globalThis.__costByModel = { measure };
