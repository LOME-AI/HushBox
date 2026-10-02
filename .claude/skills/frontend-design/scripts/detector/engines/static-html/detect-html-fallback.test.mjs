/**
 * The parser-import fallback: when `detectHtml`'s parser dependencies cannot be
 * imported it runs the regex engine instead, and the stamp on what comes back
 * must name the engine that actually ran.
 *
 * The failure is induced with a module resolve hook rather than by touching
 * `node_modules`, so nothing outside this process is affected. This file lives
 * apart from the other engine tests because `node --test` gives each file its
 * own process, which keeps the hook and the module cache from leaking into them.
 *
 * The repository runs this file automatically. Which files it runs is decided
 * by node's own test-file naming convention over the skill tree, so a name
 * outside that convention drops out of the population without a word. Run it on
 * its own with `node --test` from the repository root.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ENGINE_REGEX, ENGINE_STATIC_HTML } from '../../findings.mjs';
import { detectText } from '../regex/detect-text.mjs';
import { detectHtml } from './detect-html.mjs';

const PAGE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'test-fixtures',
  'marketing-page.html'
);

/** Deny one bare specifier so `detectHtml`'s parser import rejects. */
/** @param {string} specifier */
function denyResolution(specifier) {
  return registerHooks({
    resolve(spec, context, nextResolve) {
      if (spec === specifier) throw new Error(`resolution denied for ${spec}`);
      return nextResolve(spec, context);
    },
  });
}

test('the static-HTML entry point stamps regex when its parser dependencies fail to import', async () => {
  const hook = denyResolution('htmlparser2');
  let findings;
  try {
    findings = await detectHtml(PAGE, {});
  } finally {
    hook.deregister();
  }

  assert.ok(findings.length > 0, 'positive control: the fallback must produce findings');
  assert.deepEqual([...new Set(findings.map((f) => f.engine))], [ENGINE_REGEX]);
});

test('the fallback returns what the regex engine returns for the same file', async () => {
  const hook = denyResolution('htmlparser2');
  let findings;
  try {
    findings = await detectHtml(PAGE, {});
  } finally {
    hook.deregister();
  }
  const direct = detectText(fs.readFileSync(PAGE, 'utf-8'), PAGE, {});

  assert.ok(direct.length > 0, 'positive control: the regex engine must fire on this page');
  assert.deepEqual(
    findings.map((f) => `${f.antipattern}|${f.line}|${f.engine}`),
    direct.map((f) => `${f.antipattern}|${f.line}|${f.engine}`)
  );
});

test('the same page stamps static-html once those dependencies resolve', async () => {
  const findings = await detectHtml(PAGE, {});

  assert.ok(findings.length > 0, 'positive control: the static path must produce findings');
  assert.deepEqual([...new Set(findings.map((f) => f.engine))], [ENGINE_STATIC_HTML]);
});
