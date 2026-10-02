import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build, createServer } from 'vite';

import { PRE_PAINT_SCRIPTS, prePaintScriptsPlugin } from './pre-paint-scripts-plugin.js';

import type { HtmlTagDescriptor, IndexHtmlTransformContext } from 'vite';

let appRoot: string;

/**
 * A shell shaped like the ones the apps ship: the charset declaration first in
 * `<head>`, the entry module last in `<body>`.
 */
const SHELL = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Fixture</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/main.js"></script>
  </body>
</html>
`;

beforeAll(async () => {
  appRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pre-paint-'));
  await fs.writeFile(path.join(appRoot, 'index.html'), SHELL);
  await fs.writeFile(path.join(appRoot, 'main.js'), 'document.title = "mounted";\n');
});

afterAll(async () => {
  await fs.rm(appRoot, { recursive: true, force: true });
});

/** The HTML `vite dev` serves for the fixture shell. */
async function devHtml(): Promise<string> {
  const server = await createServer({
    root: appRoot,
    configFile: false,
    cacheDir: path.join(appRoot, 'node_modules', '.vite'),
    logLevel: 'silent',
    server: { middlewareMode: true },
    plugins: [prePaintScriptsPlugin()],
  });
  try {
    return await server.transformIndexHtml('/index.html', SHELL);
  } finally {
    await server.close();
  }
}

/**
 * The HTML `vite build` emits for the fixture shell. Memoized: the fixture is
 * read-only, and a second build would cost seconds to re-derive one string.
 */
let built: Promise<string> | undefined;
function builtHtml(): Promise<string> {
  built ??= runBuild();
  return built;
}

async function runBuild(): Promise<string> {
  const outDir = path.join(appRoot, 'dist');
  await build({
    root: appRoot,
    configFile: false,
    logLevel: 'silent',
    build: { outDir, emptyOutDir: true },
    plugins: [prePaintScriptsPlugin()],
  });
  return await fs.readFile(path.join(outDir, 'index.html'), 'utf8');
}

/**
 * Where each pre-paint script body starts in `html`, in declaration order.
 * Throws on an absent one, so a position assertion cannot pass over a fragment
 * that carries no script at all.
 */
function scriptPositions(html: string): number[] {
  return [...PRE_PAINT_SCRIPTS].map(([name, script]) => {
    const position = html.indexOf(script.trim());
    if (position === -1) throw new Error(`the ${name} pre-paint script is absent`);
    return position;
  });
}

describe('prePaintScriptsPlugin', () => {
  it('inlines every pre-paint script into the HTML the dev server serves', async () => {
    const html = await devHtml();

    for (const script of PRE_PAINT_SCRIPTS.values()) {
      expect(html).toContain(script.trim());
    }
  });

  it('inlines every pre-paint script into the HTML the build emits', async () => {
    const html = await builtHtml();

    for (const script of PRE_PAINT_SCRIPTS.values()) {
      expect(html).toContain(script.trim());
    }
  });

  it('injects each script as a bare inline tag appended to the head', () => {
    const { transformIndexHtml } = prePaintScriptsPlugin();
    const hook = transformIndexHtml as (
      html: string,
      ctx: IndexHtmlTransformContext
    ) => HtmlTagDescriptor[];

    const tags = hook(SHELL, {} as IndexHtmlTransformContext);

    expect(tags).toEqual(
      [...PRE_PAINT_SCRIPTS.values()].map((children) => ({
        tag: 'script',
        children,
        injectTo: 'head',
      }))
    );
  });

  it('leaves the charset declaration the first element in the head', async () => {
    const html = await builtHtml();

    const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
    expect(head.indexOf('<meta charset')).toBeLessThan(Math.min(...scriptPositions(head)));
  });

  it('emits the scripts in declaration order', async () => {
    const positions = scriptPositions(await builtHtml());

    expect(positions).toEqual(positions.toSorted((left, right) => left - right));
  });
});
