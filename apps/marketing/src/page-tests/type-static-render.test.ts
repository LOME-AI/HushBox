import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { Window } from 'happy-dom';
import { compile } from 'tailwindcss';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import {
  createComponent,
  render,
  renderComponent,
  type AstroComponentFactory,
} from 'astro/runtime/server/index.js';
import { Heading, Text } from '@hushbox/ui/type';

// No DOM harness renders `.astro` files in this app, so each page below is built with the
// same runtime calls the Astro compiler emits for a template that places a React
// component, and rendered through the Astro container with the site's React renderer.

// The React renderer reads its integration options from a virtual module that only the
// Astro build serves, and Vitest loads the renderer through Node, which cannot resolve it.
// This answers with the options `react()` in the site's Astro config produces.
const REACT_OPTIONS_MODULE = 'astro:react:opts';
const REACT_OPTIONS = {
  experimentalReactChildren: false,
  experimentalDisableStreaming: false,
};
registerHooks({
  resolve: (specifier, context, nextResolve) =>
    specifier === REACT_OPTIONS_MODULE
      ? {
          url: `data:text/javascript,export default ${JSON.stringify(REACT_OPTIONS)};`,
          shortCircuit: true,
        }
      : nextResolve(specifier, context),
});
const { default: reactRenderer } = await import('@astrojs/react/server.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STYLESHEET = path.resolve(HERE, '../../../../packages/config/tailwind/index.css');
const BEGIN = '/* BEGIN GENERATED: design-tokens */';
const END = '/* END GENERATED: design-tokens */';

type Directives = Readonly<Record<string, unknown>>;

function headingPage(directives: Directives = {}): AstroComponentFactory {
  return createComponent(
    (result) =>
      render`${renderComponent(
        result,
        'Heading',
        Heading,
        { level: 1, variant: 'site-post-title', ...directives },
        { default: () => render`Why we encrypt` }
      )}`
  );
}

function textPage(): AstroComponentFactory {
  return createComponent(
    (result) =>
      render`${renderComponent(
        result,
        'Text',
        Text,
        { variant: 'site-lead', as: 'p' },
        { default: () => render`Every model, one place.` }
      )}`
  );
}

async function renderPage(page: AstroComponentFactory): Promise<string> {
  const container = await AstroContainer.create();
  container.addServerRenderer({ renderer: reactRenderer });
  return container.renderToString(page);
}

async function hydratedPage(): Promise<string> {
  const container = await AstroContainer.create();
  container.addServerRenderer({ renderer: reactRenderer });
  container.addClientRenderer({
    name: '@astrojs/react',
    entrypoint: '@astrojs/react/client.js',
  });
  return container.renderToString(
    headingPage({
      'client:load': true,
      'client:component-path': '@hushbox/ui/type',
      'client:component-export': 'Heading',
      'client:component-hydration': true,
    })
  );
}

function tokenBlock(): string {
  const css = readFileSync(STYLESHEET, 'utf8');
  const start = css.indexOf(BEGIN);
  const end = css.indexOf(END, start);
  if (start === -1 || end === -1) throw new Error(`${STYLESHEET} has no token block markers`);
  return css.slice(start + BEGIN.length, end);
}

/** The heading's font size and line height in a viewport `width` wide, under the site's tokens. */
async function headingMetricsAt(
  html: string,
  width: number
): Promise<{ fontSize: string; lineHeight: string }> {
  const window = new Window({ width, height: 900 });
  window.document.body.innerHTML = html;
  const heading = window.document.querySelector('h1');
  if (heading === null) throw new Error('the page rendered no h1');
  const compiler = await compile(`${tokenBlock()}\n@tailwind utilities;\n`, { base: HERE });
  const style = window.document.createElement('style');
  style.textContent = compiler.build([...heading.classList]);
  window.document.head.append(style);
  const computed = window.getComputedStyle(heading);
  const metrics = { fontSize: computed.fontSize, lineHeight: computed.lineHeight };
  await window.happyDOM.close();
  return metrics;
}

describe('Heading and Text in an Astro page', () => {
  it('render the heading as static HTML', async () => {
    const html = await renderPage(headingPage());

    expect(html).toMatch(/<h1 class="[^"]*\btext-site-post-title\b[^"]*">Why we encrypt<\/h1>/);
  });

  it('render the text as static HTML', async () => {
    const html = await renderPage(textPage());

    expect(html).toMatch(/<p class="[^"]*\btext-site-lead\b[^"]*">Every model, one place\.<\/p>/);
  });

  it('emit no island or script for a heading placed without a client directive', async () => {
    const html = await renderPage(headingPage());

    expect(html).not.toMatch(/<astro-island|<script/);
  });

  it('emit no island or script for text placed without a client directive', async () => {
    const html = await renderPage(textPage());

    expect(html).not.toMatch(/<astro-island|<script/);
  });

  it('emit an island when a client directive asks for one, so the checks above can fail', async () => {
    const html = await hydratedPage();

    expect(html).toContain('<astro-island');
  });
});

describe('the site post title role', () => {
  it('sets its phone size below 768', async () => {
    const html = await renderPage(headingPage());

    expect(await headingMetricsAt(html, 767)).toEqual({ fontSize: '36px', lineHeight: '1.111' });
  });

  it('steps to its desktop size from 768', async () => {
    const html = await renderPage(headingPage());

    expect(await headingMetricsAt(html, 768)).toEqual({ fontSize: '48px', lineHeight: '1' });
  });
});
