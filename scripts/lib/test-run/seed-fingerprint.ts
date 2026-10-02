import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

const SEED_ENTRY = path.join('scripts', 'seed.ts');
const SEED_TSCONFIG = path.join('scripts', 'tsconfig.json');
const LOCKFILE = 'pnpm-lock.yaml';
/**
 * Matched against the compiler's resolved file names, which are `/`-separated on
 * every platform, so the separator here is `/` and never `path.sep`.
 */
const NODE_MODULES = '/node_modules/';

/**
 * A scheme-prefixed specifier names no file of this checkout and no installed
 * package; `node:fs` and `cloudflare:workers` name modules the runtime
 * provides. Two characters at least, so a Windows drive is never read as a
 * scheme.
 */
const RUNTIME_MODULE = /^[a-z][\d+.a-z-]+:/;

function resolutionOptions(configPath: string): ts.CompilerOptions {
  const read = ts.readConfigFile(configPath, (file) => ts.sys.readFile(file));
  if (read.error !== undefined) {
    throw new Error(`seed-fingerprint: cannot read ${configPath}`);
  }
  return ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    path.dirname(configPath),
    undefined,
    configPath
  ).options;
}

/**
 * The checkout file an import lands on, or undefined for one whose content the
 * lockfile answers for — an installed package — or the runtime provides.
 */
function importTarget(
  specifier: string,
  importer: string,
  root: string,
  options: ts.CompilerOptions
): string | undefined {
  if (RUNTIME_MODULE.test(specifier)) return undefined;
  const resolved = ts.resolveModuleName(specifier, importer, options, ts.sys).resolvedModule;
  if (resolved === undefined) {
    throw new Error(
      `seed-fingerprint: cannot resolve '${specifier}', imported by ` +
        `${path.relative(root, importer)}, to a file of this checkout or an installed package`
    );
  }
  // A workspace package resolves through the link pnpm puts in the importer's
  // `node_modules`. The compiler answers with the link's target but still flags
  // the import external, so the flag cannot tell it from an installed package
  // and the resolved path is read instead.
  const target = resolved.resolvedFileName;
  return target.includes(NODE_MODULES) ? undefined : target;
}

function reachableFiles(entry: string, root: string, options: ts.CompilerOptions): Set<string> {
  const reached = new Set<string>();
  const pending = [entry];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (reached.has(file)) continue;
    reached.add(file);
    const { importedFiles } = ts.preProcessFile(readFileSync(file, 'utf8'), true, true);
    for (const { fileName: specifier } of importedFiles) {
      const target = importTarget(specifier, file, root, options);
      if (target !== undefined) pending.push(target);
    }
  }
  return reached;
}

function contentDigest(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * One digest over what the database seed imports: every checkout file reachable
 * from `scripts/seed.ts` by import, and `pnpm-lock.yaml`, which answers for
 * every installed package the walk stops at.
 *
 * Imports resolve through the compiler's own module resolution under the
 * seed's tsconfig, so a workspace alias lands on the package source it names.
 * An import that is not scheme-prefixed and resolves to nothing under those
 * options is refused by name rather than skipped: a skipped one would be an
 * input this digest silently stops covering. A file the seed reads at run time
 * rather than imports is invisible to the walk.
 *
 * Each file enters under its path relative to the checkout, with `/`
 * separators, in code-unit order, so where the tree sits and the order its
 * files were written in leave the digest unchanged.
 */
export function seedInputsFingerprint(repoRoot: string): string {
  const root = realpathSync(repoRoot);
  const options = resolutionOptions(path.join(root, SEED_TSCONFIG));
  const files = [
    ...reachableFiles(path.join(root, SEED_ENTRY), root, options),
    path.join(root, LOCKFILE),
  ];
  const entries = files
    .map((file) => ({ file, key: path.relative(root, file).split(path.sep).join('/') }))
    .toSorted((left, right) => (left.key < right.key ? -1 : Number(left.key > right.key)));

  const digest = createHash('sha256');
  for (const { file, key } of entries) digest.update(`${key}:${contentDigest(file)}\n`);
  return digest.digest('hex');
}
