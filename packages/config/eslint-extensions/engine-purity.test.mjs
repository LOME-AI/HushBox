// Programmatic ESLint tests for the engine/node purity lint set. The config
// is applied directly to fixture code at synthetic paths, so the rules'
// absolute-filename self-scoping is exercised without real files.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import extensionConfig from './engine-purity.config.mjs';

const cwd = path.dirname(fileURLToPath(import.meta.url));

function createLinter() {
  return new ESLint({
    cwd,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
      ...extensionConfig,
    ],
  });
}

/**
 * @param {string} code
 * @param {string} filePath
 */
async function purityMessages(code, filePath) {
  const [result] = await createLinter().lintText(code, {
    filePath: path.join(cwd, ...filePath.split('/')),
  });
  if (result === undefined) throw new Error('ESLint returned no lint result');
  return result.messages.filter((m) => m.ruleId === 'engine-purity/engine-node-purity');
}

/**
 * @param {string} code
 * @param {string} filePath
 */
async function registryMessages(code, filePath) {
  const [result] = await createLinter().lintText(code, {
    filePath: path.join(cwd, ...filePath.split('/')),
  });
  if (result === undefined) throw new Error('ESLint returned no lint result');
  return result.messages.filter((m) => m.ruleId === 'engine-purity/capability-registry-only');
}

const ENGINE = 'apps/api/src/slices/workflows/domain/engine/interpreter.ts';
const ENGINE_TEST = 'apps/api/src/slices/workflows/domain/engine/interpreter.test.ts';
const ENGINE_SETUP = 'apps/api/src/slices/workflows/domain/engine/interpreter.setup.ts';
const NODE = 'apps/api/src/slices/workflows/domain/nodes/model-call-execution.ts';
const BILLING = 'apps/api/src/slices/billing/domain/charge.ts';
const REGISTRY = 'apps/api/src/slices/workflows/domain/engine/live-execution-registry.ts';

describe('engine-node-purity', () => {
  it('flags raw Date.now / Math.random / fetch in engine code', async () => {
    const code = 'const a = Date.now();\nconst b = Math.random();\nfetch("/x");\n';
    expect(await purityMessages(code, ENGINE)).toHaveLength(3);
  });

  it('flags the same raw globals in node code', async () => {
    expect(await purityMessages('const a = Date.now();\n', NODE)).toHaveLength(1);
  });

  it('flags global-rooted forms: globalThis.Date.now, window.Math.random, self.fetch, window.fetch', async () => {
    const code =
      'globalThis.Date.now();\nwindow.Math.random();\nself.fetch("/x");\nwindow.fetch("/y");\n';
    expect(await purityMessages(code, ENGINE)).toHaveLength(4);
  });

  it('does NOT flag other slices — the raw globals are legal in billing', async () => {
    const code = 'const a = Date.now();\nconst b = Math.random();\nfetch("/x");\n';
    expect(await purityMessages(code, BILLING)).toEqual([]);
  });

  it('flags a zero-argument new Date() in engine code', async () => {
    expect(await purityMessages('const t = new Date();\n', ENGINE)).toHaveLength(1);
  });

  it('flags argument-taking date construction in engine code', async () => {
    expect(await purityMessages('const t = new Date(ms);\n', ENGINE)).toHaveLength(1);
  });

  it('flags Date.parse in engine code', async () => {
    expect(await purityMessages('const t = Date.parse(iso);\n', ENGINE)).toHaveLength(1);
  });

  it('flags the global-rooted argument-taking and parse forms', async () => {
    const code = 'const t = new globalThis.Date(ms);\nwindow.Date.parse(iso);\n';
    expect(await purityMessages(code, ENGINE)).toHaveLength(2);
  });

  it('allows Date.UTC and crypto.subtle in engine code', async () => {
    const code = 'const t = Date.UTC(y, m);\ncrypto.subtle.digest("SHA-256", bytes);\n';
    expect(await purityMessages(code, ENGINE)).toEqual([]);
  });

  it('allows the banned clock and entropy forms in an engine test file', async () => {
    const code = 'const t = new Date(0);\nDate.parse(iso);\ncrypto.randomUUID();\n';
    expect(await purityMessages(code, ENGINE_TEST)).toEqual([]);
  });

  it('allows the banned clock and entropy forms in an engine test-setup file', async () => {
    const code = 'const t = new Date(0);\nDate.parse(iso);\ncrypto.randomUUID();\n';
    expect(await purityMessages(code, ENGINE_SETUP)).toEqual([]);
  });

  it('flags performance.now() in engine code', async () => {
    expect(await purityMessages('const t = performance.now();\n', ENGINE)).toHaveLength(1);
  });

  it('flags crypto.randomUUID() in node code', async () => {
    expect(await purityMessages('const id = crypto.randomUUID();\n', NODE)).toHaveLength(1);
  });

  it('flags crypto.getRandomValues() in node code', async () => {
    const code = 'crypto.getRandomValues(bytes);\n';
    expect(await purityMessages(code, NODE)).toHaveLength(1);
  });

  it('flags global-rooted clock and entropy forms', async () => {
    const code =
      'const t = new globalThis.Date();\nwindow.performance.now();\nself.crypto.randomUUID();\nglobalThis.crypto.getRandomValues(bytes);\n';
    expect(await purityMessages(code, ENGINE)).toHaveLength(4);
  });

  it('does NOT flag the clock and entropy forms outside engine/node code', async () => {
    const code =
      'const t = new Date(ms);\nDate.parse(iso);\nperformance.now();\ncrypto.randomUUID();\ncrypto.getRandomValues(bytes);\n';
    expect(await purityMessages(code, BILLING)).toEqual([]);
  });

  it('flags a node runtime import of a cross-slice barrel', async () => {
    const code = "import { chargeWithinTx } from '../../../billing/index.js';\n";
    expect(await purityMessages(code, NODE)).toHaveLength(1);
  });

  it('flags a node runtime import of @hushbox/db', async () => {
    expect(await purityMessages("import { sql } from '@hushbox/db';\n", NODE)).toHaveLength(1);
  });

  it('allows a type-only barrel import in node code', async () => {
    const code = "import type { ModelProvider } from '../../../models/index.js';\n";
    expect(await purityMessages(code, NODE)).toEqual([]);
  });

  it('does not restrict barrel value imports in engine (non-node) code', async () => {
    const code = "import { chargeWithinTx } from '../../../billing/index.js';\n";
    expect(await purityMessages(code, REGISTRY)).toEqual([]);
  });
});

describe('capability-registry-only', () => {
  it('flags an interpreter importing a capability node execution directly', async () => {
    const code = "import { createModelCallExecution } from '../nodes/model-call-execution.js';\n";
    expect(await registryMessages(code, ENGINE)).toHaveLength(1);
  });

  it('allows the registry to import capability node executions', async () => {
    const code = "import { createModelCallExecution } from '../nodes/model-call-execution.js';\n";
    expect(await registryMessages(code, REGISTRY)).toEqual([]);
  });

  it('allows a type-only re-export of a capability type', async () => {
    const code = "export type { ModelBinding } from '../nodes/model-call-execution.js';\n";
    expect(await registryMessages(code, ENGINE)).toEqual([]);
  });

  it('flags a dynamic import of a capability node execution', async () => {
    const code = "export const load = () => import('../nodes/model-call-execution.js');\n";
    expect(await registryMessages(code, ENGINE)).toHaveLength(1);
  });

  it('flags a star re-export of a capability node execution', async () => {
    const code = "export * from '../nodes/model-call-execution.js';\n";
    expect(await registryMessages(code, ENGINE)).toHaveLength(1);
  });

  it('leaves a dynamic import alone when the specifier is not a literal', async () => {
    const code = 'export const load = (name: string) => import(name);\n';
    expect(await registryMessages(code, ENGINE)).toEqual([]);
  });

  it('leaves an ordinary relative import in engine code alone', async () => {
    const code =
      "import { createValueStore } from './value-store.js';\nexport const s = createValueStore;\n";
    expect(await registryMessages(code, ENGINE)).toEqual([]);
  });

  it('exempts a test-setup module reaching a capability node execution', async () => {
    const code = "import { createModelCallExecution } from '../nodes/model-call-execution.js';\n";
    expect(await registryMessages(code, ENGINE_SETUP)).toEqual([]);
  });

  it('leaves package imports alone — only relative paths can reach a node execution', async () => {
    const code = "import { z } from 'zod';\nexport const s = z;\n";
    expect(await registryMessages(code, ENGINE)).toEqual([]);
  });
});
