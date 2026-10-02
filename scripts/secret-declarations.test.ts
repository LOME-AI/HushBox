/**
 * Every GitHub secret a workflow reads is declared in exactly one place, and
 * every declaration held outside the env registry is read by some workflow.
 *
 * Three homes declare a `secrets.NAME`: the env registry, through a `secret()`
 * marker in any mode — one entry can name two GitHub secrets, one per mode, and
 * both count; `CI_SECRETS`, for credentials the registry does not hold; and
 * `CI_IDENTIFIERS`, for values held as secrets that grant nothing. A name in
 * two homes is described twice; a name in none is undescribed. Both are checked
 * by reading the workflows the way GitHub does rather than from a list.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { CI_IDENTIFIERS, CI_SECRETS } from '../packages/shared/src/env/ci-secrets.js';
import { envConfig } from '../packages/shared/src/env/env.config.js';
import { Mode, isSecret, resolveRaw } from '../packages/shared/src/env/env-types.js';
import { escrowedSecretNames } from './generate-env.js';
import { ESCROW_BUCKET_ENV_NAMES } from './lib/escrow/upload.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = path.join(REPO_ROOT, '.github', 'workflows');

/**
 * A `${{ }}` expression, the only place the `secrets` context is readable. The
 * interior stops short of the closing `}}` so the delimiters bound the match.
 */
const EXPRESSION = /\$\{\{(?:[^}]|\}(?!\}))*\}\}/g;

/**
 * The `secrets` context inside an expression, with the dotted name when one
 * follows. The lookbehind keeps the context apart from anything ending in the
 * word, such as the output of a step whose id ends in `secrets`. A context
 * spelled without a dotted name — the index form, or the whole context handed
 * to a function — names no single secret, so the reader refuses it rather than
 * counting it as nothing.
 */
const SECRETS_CONTEXT = /(?<![\w.-])secrets\b(\.\w+)?/g;

type Home = 'registry' | 'CI_SECRETS' | 'CI_IDENTIFIERS';

/** Every string value in a parsed workflow, wherever it sits. */
function strings(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap((item) => strings(item));
  if (node !== null && typeof node === 'object') {
    return Object.values(node).flatMap((value) => strings(value));
  }
  return [];
}

/** The secret names one workflow file references. */
function referencesIn(file: string): Set<string> {
  const workflow: unknown = parse(readFileSync(path.join(WORKFLOWS, file), 'utf8'));
  const names = new Set<string>();
  for (const text of strings(workflow)) {
    for (const [expression] of text.matchAll(EXPRESSION)) {
      for (const [, dotted] of expression.matchAll(SECRETS_CONTEXT)) {
        if (dotted === undefined) {
          throw new Error(`${file}: a 'secrets' reference this reader cannot name: ${expression}`);
        }
        names.add(dotted.slice(1));
      }
    }
  }
  return names;
}

/** Secret name → the workflow files that reference it. */
function collectReferences(): Map<string, string[]> {
  const references = new Map<string, string[]>();
  for (const file of readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name))) {
    for (const name of referencesIn(file)) {
      references.set(name, [...(references.get(name) ?? []), file]);
    }
  }
  return references;
}

const REFERENCES = collectReferences();

/** Every GitHub secret name the registry's `secret()` markers name, in any mode. */
const REGISTRY_NAMES = new Set(
  Object.values(envConfig).flatMap((config) =>
    Object.values(Mode).flatMap((mode) => {
      const raw = resolveRaw(config, mode);
      return isSecret(raw) ? [raw.name] : [];
    })
  )
);

function homesOf(name: string): Home[] {
  const homes: Home[] = [];
  if (REGISTRY_NAMES.has(name)) homes.push('registry');
  if (Object.hasOwn(CI_SECRETS, name)) homes.push('CI_SECRETS');
  if (CI_IDENTIFIERS.includes(name)) homes.push('CI_IDENTIFIERS');
  return homes;
}

describe('workflow secret references', () => {
  it('resolves every referenced name to exactly one declaration', () => {
    const unresolved: Record<string, { homes: Home[]; files: string[] }> = {};
    for (const [name, files] of REFERENCES) {
      const homes = homesOf(name);
      if (homes.length !== 1) unresolved[name] = { homes, files };
    }
    expect(unresolved).toEqual({});
  });
});

/**
 * The escrow job's own workflow. It binds the whole escrow set in one place, so
 * that set is readable from one file rather than assembled across the jobs that
 * each hold a subset.
 */
const ESCROW_WORKFLOW = 'escrow-secrets.yml';

describe('the escrow workflow', () => {
  // What a workflow references is a GitHub secret name, which is the escrowed
  // declaration's production secret and not its key: one declaration can name a
  // different secret per mode, and the escrow reads the production one.
  it('binds exactly the escrow set beside its bucket bindings', () => {
    const referenced = referencesIn(ESCROW_WORKFLOW);
    const escrowed = new Set(escrowedSecretNames());
    const transport = new Set<string>(Object.values(ESCROW_BUCKET_ENV_NAMES));

    expect({
      missing: [...escrowed].filter((name) => !referenced.has(name)),
      unescrowed: [...referenced].filter((name) => !escrowed.has(name) && !transport.has(name)),
    }).toEqual({ missing: [], unescrowed: [] });
  });
});

describe('secret declarations outside the registry', () => {
  it('reads every CI_SECRETS key from some workflow', () => {
    const dead = Object.keys(CI_SECRETS).filter((name) => !REFERENCES.has(name));
    expect(dead).toEqual([]);
  });

  it('reads every CI_IDENTIFIERS member from some workflow', () => {
    const dead = CI_IDENTIFIERS.filter((name) => !REFERENCES.has(name));
    expect(dead).toEqual([]);
  });
});
