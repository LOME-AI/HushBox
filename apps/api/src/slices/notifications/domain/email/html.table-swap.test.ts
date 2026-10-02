import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EMAIL_PALETTE } from '@hushbox/shared/design-tokens';
import { TEST_YEAR_START } from '@hushbox/shared/test-instants';
import { renderEmailHtml } from './html.js';
import { EMAIL_STYLES, EMAIL_SURFACES } from './styles.js';
import type { ResolvedEmail } from './document.js';

// Every paint role is swapped, for the life of this file, to one no production row
// uses for that thing, so an output still showing a production role was written from
// somewhere other than the tables. The tables are read-only by type, not frozen, and the
// writer reads them per call, so assigning into them is the swap.
const ORIGINAL = {
  button: { ...EMAIL_STYLES.button },
  canvas: { ...EMAIL_SURFACES.canvas },
  card: { ...EMAIL_SURFACES.card },
  rule: { ...EMAIL_SURFACES.rule },
};

beforeAll(() => {
  Object.assign(EMAIL_STYLES.button, { background: 'codeWell' });
  Object.assign(EMAIL_SURFACES.canvas, { background: 'cardBorder' });
  Object.assign(EMAIL_SURFACES.card, { background: 'codeWell', border: 'muted' });
  Object.assign(EMAIL_SURFACES.rule, { border: 'accent' });
});

afterAll(() => {
  Object.assign(EMAIL_STYLES.button, ORIGINAL.button);
  Object.assign(EMAIL_SURFACES.canvas, ORIGINAL.canvas);
  Object.assign(EMAIL_SURFACES.card, ORIGINAL.card);
  Object.assign(EMAIL_SURFACES.rule, ORIGINAL.rule);
});

const DARK = EMAIL_PALETTE.dark;
const LIGHT = EMAIL_PALETTE.light;

const EMAIL: ResolvedEmail = {
  subject: 'The subject',
  heading: 'The heading',
  preheader: 'The preview',
  body: {
    blocks: [{ kind: 'table', layout: 'figures', rows: [['Fee', ['5%']]] }],
    action: { kind: 'link', label: 'Open', href: 'https://example.test/open' },
  },
};

function render(): string {
  return renderEmailHtml(EMAIL, { sentAt: new Date(TEST_YEAR_START) });
}

function styleOfClass(className: string): string[] {
  return [
    ...render().matchAll(
      new RegExp(String.raw`<[a-z0-9]+ [^>]*class="[^"]*\b${className}\b[^"]*"[^>]*>`, 'g')
    ),
  ].map((match) => match[0]);
}

function lightBlock(): string {
  const html = render();
  const start = html.indexOf('@media (prefers-color-scheme: light)');
  return html.slice(start, html.indexOf('</style>'));
}

describe('renderEmailHtml reads every paint role from the tables', () => {
  it('paints the canvas from its table row in the dark scheme', () => {
    const tags = styleOfClass('email-surface-canvas');
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) expect(tag).toContain(`background-color:${DARK.cardBorder};`);
  });

  it('paints the card from its table row in the dark scheme', () => {
    const [card] = styleOfClass('email-surface-card');
    expect(card).toContain(`background-color:${DARK.codeWell};`);
    expect(card).toContain(`border:1px solid ${DARK.muted};`);
  });

  it('draws every rule from its table row in the dark scheme', () => {
    const tags = styleOfClass('email-surface-rule');
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags)
      expect(tag).toMatch(new RegExp(`border-(top|bottom):1px solid ${DARK.accent};`));
  });

  it('fills the button cell and link from the button row in the dark scheme', () => {
    const fills = styleOfClass('email-button-fill');
    expect(fills).toHaveLength(2);
    for (const tag of fills) expect(tag).toContain(`background-color:${DARK.codeWell};`);
    expect(fills[0]).toContain(`bgcolor="${DARK.codeWell}"`);
  });

  it('paints every surface from its table row in the light scheme', () => {
    const light = lightBlock();
    expect(light).toContain(
      `.email-surface-canvas { background-color: ${LIGHT.cardBorder} !important; }`
    );
    expect(light).toContain(
      `.email-surface-card { background-color: ${LIGHT.codeWell} !important; border-color: ${LIGHT.muted} !important; }`
    );
    expect(light).toContain(`.email-surface-rule { border-color: ${LIGHT.accent} !important; }`);
  });

  it('fills the button from the button row in the light scheme', () => {
    expect(lightBlock()).toContain(
      `.email-button-fill { background-color: ${LIGHT.codeWell} !important; }`
    );
  });
});
