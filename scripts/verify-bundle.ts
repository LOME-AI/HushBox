/**
 * Guards on a built app bundle.
 *
 * This module is Node-side build tooling: a browser-targeted bundle importing
 * it builds, then throws a TypeError at load (built and run to confirm).
 *
 * The classes of problem it turns into a verification failure:
 *   - TTS shipped by an app that never asked for it: whether an app carries the
 *     on-device speech engine is a declaration here (`APPS_SHIPPING_TTS`), not
 *     whatever the module graph happened to drag in. The bundler emits the TTS
 *     worker and its ORT runtime at transform time, before tree-shaking, and
 *     emitted assets are never collected again — so an accidental import costs
 *     tens of megabytes with no other symptom.
 *   - onnxruntime-web bloat: the TTS worker must reference only the
 *     self-hosted `/ort/` runtime. A bundler-emitted copy (or a built chunk
 *     still pointing at one) means the wasm ships two or three times — tens of
 *     megabytes in every Pages deploy, APK, and OTA zip.
 *   - onnxruntime version skew: which onnxruntime-common copy ends up in the
 *     worker rests on a workspace package extension that only applies to one
 *     exact `@huggingface/transformers` version, so a transformers bump can
 *     silently swap it, or split the chunk across two versions.
 *   - worker `new.target` corruption: a worker transform that rewrites
 *     `new.target` into an `import.meta` stand-in kills the TTS worker on load
 *     in every built site while dev stays green. The iife transform did this on
 *     rolldown 1.0.0-beta.53 and no longer does on 1.2.1 (built both ways to
 *     confirm) — the guard stays because the failure is silent in dev and
 *     catastrophic in the built site, not because it currently reproduces.
 *   - backend environment material in a public origin: entry names and the
 *     credential-shaped placeholders the registry carries outside production
 *     have no business being served from any origin this repo ships. A single
 *     module import was enough, and it happened — the web, marketing, admin
 *     and OTA bundles all carried the backend entry names, inlined as the Zod
 *     schema stating them, with nothing on the tree reporting it. The registry
 *     object itself did not reach those bundles, so its placeholders did not
 *     either; under a different minifier it would have, which is why the check
 *     reads both shapes. Ahead of this, at the source level, the
 *     `published-doors-stay-browser-safe` and
 *     `node-only-doors-have-declared-consumers` architecture rules refuse the
 *     reach; this check reads the artifact, which no source rule can.
 *   - the OPAQUE protocol stack in a marketing chunk: the public pages
 *     authenticate nobody, and the stack arrives through module top-level
 *     side effects rather than through a symbol anything references — so
 *     tree-shaking cannot remove it and only the shape of the crypto
 *     package's published doors keeps it out. Source tells you which door a
 *     component imports; the chunk tells you what shipped.
 *   - the E2E device-key store in a production bundle: the plaintext
 *     localStorage variant of the export-key store is swapped in at
 *     module-resolution time, so every guard on it — the arch rule, the
 *     resolver's own flag gate — reasons about source. This is the one that
 *     reads the artifact, which is what a config or flag mistake produces.
 *   - the E2E prompt-predictor stub in a production bundle: the same build
 *     flag picks it the same way, so the same reasoning applies and the same
 *     artifact read is what catches it.
 *   - React's development build in an app's own chunks, which ship the build
 *     users run, or missing from an E2E build's marketing islands, where its
 *     hydration comparison is the suite's only hydration check.
 *   - a pre-paint bootstrap script missing from a built SPA shell: one plugin
 *     registration in an app's Vite config is what inlines them, so a config
 *     that never registered it paints the default theme with no accessibility
 *     adjustments and jumps to the stored ones after mount. Nothing else on the
 *     tree reports it — the end-to-end suite reads those classes only after
 *     mount.
 *   - a static origin's `_headers` gone missing: the file is written by the
 *     same build step that runs this check, so dropping that step costs the
 *     origin its CSP silently.
 *   - Cloudflare Pages hard limits: exceeding either one fails the deploy, and
 *     a routine transformers bump is enough to push the ORT wasm past the
 *     per-file cap. Failing here surfaces it at build time instead.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The `packages/shared` modules below are reached by source path rather than by
// a package specifier. `growth/beacon-references` is published under no subpath
// at all, so no bare specifier names it; the other two are published, as the
// registry's node-only doors, and are spelled the same way so this file reaches
// the package by one rule. `generate-headers.ts` and `lib/bundling/seam.ts`
// reach the same package the same way.
import { envRegistryContentIn } from '../packages/shared/src/env/env-registry-content.ts';
import {
  envConfig,
  isSecret,
  Mode,
  resolveRaw,
  type EnvMode,
  type VariableConfig,
} from '../packages/shared/src/env/env.config.ts';

import { growthBeaconReferencesIn } from '../packages/shared/src/growth/beacon-references.ts';

import { frontendEnvFile } from './lib/bundling/build-mode.ts';
import { ORT_DIR, resolveOrtAssets, type OrtAsset } from './lib/bundling/seam.ts';
import { PRE_PAINT_SCRIPTS } from './lib/bundling/pre-paint-scripts-plugin.ts';
import { isMainModule } from './lib/cli/is-main.ts';
import { readCommandLine, type CommandSpec, type FlagRecord } from './lib/cli/command-line.ts';
import { runMain } from './lib/cli/run-main.ts';
import { envModeOrDefault, frontendModeFor } from './lib/stack/stack-mode.ts';
import {
  IOS_PROJECT_PATH,
  collectBuildTargetViolations,
  collectDeploymentTargetViolations,
  writeDeploymentTarget,
} from './lib/bundling/build-targets.ts';

// Cloudflare Pages hard limits: 25 MiB per file, 20,000 files per deployment.
export const PAGES_MAX_FILE_BYTES = 26_214_400;
export const PAGES_MAX_FILE_COUNT = 20_000;

/**
 * Which apps ship the on-device TTS engine, keyed by workspace-relative app
 * directory. Read by `appBundleOptions` below, which throws for an app absent
 * from this map rather than assuming an answer for it.
 */
const APPS_SHIPPING_TTS = new Map<string, boolean>([
  // The merged web + marketing bundle: blog read-aloud and chat read-aloud.
  ['apps/web', true],
  ['apps/admin', false],
  ['apps/crawler-view', false],
  // The sandbox origin: static pages plus the self-hosted Pyodide payload.
  ['apps/sandbox', false],
]);

/** The dist directory an app builds into unless a build asks for another one. */
const PRIMARY_DIST_DIR = 'dist';

/**
 * @param appDir the app's TTS expectation is keyed on this and nothing else.
 * @param distributionDirName which of that app's dist directories to verify. An app can
 *   build into more than one — `apps/web` also emits `dist-ios`, `dist-android`
 *   and `dist-android-direct` from the same vite config for the OTA bundles —
 *   and every one of them carries the app's single declaration, so the location
 *   varies here while the expectation stays where it is declared above.
 * @param envMode the mode the build was invoked for. Its stack's generated env
 *   file is the one the bundle's baked values are compared against, named for
 *   the stack rather than for the mode, because that is how a bundler resolves
 *   one. Omitted by a caller that can name no stack.
 */
export function appBundleOptions(
  rootDir: string,
  appDir: string,
  distributionDirName: string = PRIMARY_DIST_DIR,
  envMode?: EnvMode
): VerifyBundleOptions {
  const shipsTts = APPS_SHIPPING_TTS.get(appDir);
  if (shipsTts === undefined) {
    throw new Error(
      `${appDir} has no declared TTS expectation — an app whose bundle is verified must ` +
        `declare whether it ships the on-device TTS engine`
    );
  }
  return {
    distributionDir: path.join(rootDir, appDir, distributionDirName),
    shipsTts,
    ...(envMode === undefined
      ? {}
      : { stackEnvFile: path.join(rootDir, frontendEnvFile(frontendModeFor(envMode))) }),
  };
}

/** The web dist directories named as CLI arguments, defaulting to the primary one. */
export function requestedDistributionDirectories(args: readonly string[]): string[] {
  return args.length > 0 ? [...args] : [PRIMARY_DIST_DIR];
}

/**
 * The workspace file carries the `packageExtensions` entry that declares
 * onnxruntime-common as a dependency of `@huggingface/transformers`, which
 * imports it as a bare external without declaring it. That entry is what
 * decides which ORT copy the TTS worker resolves. Reading the version from
 * there — never copying its value — is what turns it into a build-time
 * invariant.
 */
const PNPM_WORKSPACE_YAML = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../pnpm-workspace.yaml'
);

/**
 * The declared version, matched structurally so a value picked up from any
 * other block cannot pass for it: the transformers selector, its
 * `dependencies` map, then the key, each on its own line.
 */
const ORT_COMMON_EXTENSION =
  /^[ \t]+'?@huggingface\/transformers@[^'\s:]+'?:[ \t]*\n[ \t]+dependencies:[ \t]*\n[ \t]+onnxruntime-common:[ \t]*'?([^'\s#]+)/mu;

/** A range would let the shipped copy drift while still satisfying the pin. */
const EXACT_VERSION = /^\d+\.\d+\.\d+[\w+.-]*$/u;

/**
 * The version every ORT copy in the bundle must report.
 *
 * @param workspaceYaml file carrying the extension; the default is the real one.
 */
export async function declaredOrtCommonVersion(
  workspaceYaml: string = PNPM_WORKSPACE_YAML
): Promise<string> {
  const declared = ORT_COMMON_EXTENSION.exec(await fs.readFile(workspaceYaml, 'utf8'))?.[1];
  if (declared === undefined || !EXACT_VERSION.test(declared)) {
    throw new Error(
      `${workspaceYaml} must declare onnxruntime-common at an exact version in the ` +
        `@huggingface/transformers packageExtensions entry (found ` +
        `${declared ?? 'no declaration'}) — that entry decides which ORT copy resolves ` +
        `into the shipped TTS worker.`
    );
  }
  return declared;
}

/**
 * The E2E-only device-key store: it persists the OPAQUE export key as plaintext
 * in localStorage so Playwright `storageState` can carry it between contexts,
 * and the apps/web Vite config substitutes it for the real store at
 * module-resolution time when the build bakes the E2E flag. Read for its
 * storage key rather than restating it, so renaming that key cannot leave this
 * check hunting a string the store no longer writes.
 */
const E2E_DEVICE_KEY_STORE_MODULE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../apps/web/src/lib/device-key-store.e2e.ts'
);

/** A storage-key declaration in the store, whichever quote style it is written in. */
const E2E_STORAGE_KEY_DECLARATION = /\bSTORAGE_KEY\w*\s*=\s*(['"])([^'"]+)\1/gu;

/**
 * The literals that identify the E2E store inside a built artifact. A string
 * literal is what survives minification intact, which is why the keys are the
 * needles and the module's name is not.
 *
 * Every declaration, never the first: a reader that stops at one leaves each
 * later key invisible to the assertion built on it, which is a guard reporting
 * green over exactly what it exists to catch.
 *
 * @param storeModule module carrying the declarations; the default is the real one.
 */
export async function declaredE2eDeviceKeyMarkers(
  storeModule: string = E2E_DEVICE_KEY_STORE_MODULE
): Promise<string[]> {
  const source = await fs.readFile(storeModule, 'utf8');
  const declared = [...source.matchAll(E2E_STORAGE_KEY_DECLARATION)]
    .map((match) => match[2])
    .filter((value): value is string => value !== undefined);
  if (declared.length === 0) {
    throw new Error(
      `${storeModule} must declare the storage key its E2E device-key store writes — ` +
        `that literal is the only thing identifying the store in a built artifact, and ` +
        `without it the absence check passes on every bundle.`
    );
  }
  return declared;
}

/**
 * The E2E-only prompt-predictor stub: it answers the composer with fixed text
 * instead of running a model, and the apps/web Vite config aliases it over the
 * production predictor when the build bakes the E2E flag. Read for the answers
 * it declares rather than restating them, so editing the text cannot leave this
 * check hunting phrases the stub no longer returns.
 */
const E2E_PROMPT_PREDICTOR_MODULE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../apps/web/src/lib/prediction/prompt-predictor.e2e.ts'
);

/**
 * The stub's fixed answers, whichever declaration holds them — one string for
 * the completion, an array for the rivals. Scoped to those two names rather
 * than every literal in the module, because the module also carries an abort
 * message the production predictor raises word for word, and a marker both
 * modules share would fail every bundle.
 */
const E2E_PREDICTOR_ANSWER_DECLARATION =
  /\b(?:COMPLETION|ALTERNATIVES)\b[^=;]*=(?<answers>[^;]*);/gu;

/** A string literal in whichever quote style it was written in. */
const SINGLE_LINE_STRING_LITERAL = /(?<quote>['"])(?<text>[^'"]+)\k<quote>/gu;

/**
 * The literals that identify the stub inside a built artifact. A string literal
 * is what survives minification intact, which is why the answers are the
 * needles and the module's name is not.
 *
 * @param stubModule module carrying the declarations; the default is the real one.
 */
export async function declaredE2ePredictorMarkers(
  stubModule: string = E2E_PROMPT_PREDICTOR_MODULE
): Promise<string[]> {
  const source = await fs.readFile(stubModule, 'utf8');
  const declared = [...source.matchAll(E2E_PREDICTOR_ANSWER_DECLARATION)]
    .flatMap((match) => [...(match.groups?.['answers'] ?? '').matchAll(SINGLE_LINE_STRING_LITERAL)])
    .map((match) => match.groups?.['text'])
    .filter((value): value is string => value !== undefined);
  if (declared.length === 0) {
    throw new Error(
      `${stubModule} must declare the answers its E2E prompt-predictor stub returns — ` +
        `those literals are the only thing identifying the stub in a built artifact, and ` +
        `without them the absence check passes on every bundle.`
    );
  }
  return declared;
}

/**
 * The package holding the OPAQUE protocol implementation, resolved from
 * `packages/crypto`, which is where it is installed and the only workspace that
 * depends on it. Anchoring resolution there is what keeps it out of this
 * package's own dependencies — the same anchoring `seam.ts` uses to reach the
 * ORT runtime through `packages/ui`.
 */
const CRYPTO_PACKAGE_JSON = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../packages/crypto/package.json'
);

const OPAQUE_PACKAGE = '@cloudflare/opaque-ts';

function opaqueLibraryDir(anchorPackageJson: string = CRYPTO_PACKAGE_JSON): string {
  return path.dirname(createRequire(anchorPackageJson).resolve(OPAQUE_PACKAGE));
}

/**
 * A domain-separation label as the library's own source writes it. RFC 9807
 * fixes these strings: an implementation that renamed one would no longer
 * interoperate, so they identify the protocol stack in a built artifact more
 * durably than any symbol a minifier is free to rename.
 *
 * The quoting is the library's, not a bundle's, because this reads compiled
 * source rather than shipped output. A library restyled onto other quotes
 * yields nothing here, and the reader below refuses an empty set rather than
 * letting a check pass over needles it never found.
 */
const OPAQUE_PROTOCOL_LABEL = /'(?<label>OPAQUE-[A-Za-z]+)'/gu;

/**
 * The literals that identify the OPAQUE protocol stack inside a built artifact.
 *
 * Derived from the installed library, never listed here: a list leaves every
 * label the library gains after it was written unchecked, and silently.
 *
 * @param libraryDir directory holding the library's modules; the default is the
 *   installed one.
 */
export async function declaredOpaqueProtocolLabels(
  libraryDir: string = opaqueLibraryDir()
): Promise<string[]> {
  const entries = await fs.readdir(libraryDir, { recursive: true });
  const modules = entries
    .filter((name) => name.endsWith('.js'))
    .toSorted((left, right) => left.localeCompare(right));
  const declared = new Set<string>();
  for (const name of modules) {
    const source = await fs.readFile(path.join(libraryDir, name), 'utf8');
    for (const match of source.matchAll(OPAQUE_PROTOCOL_LABEL)) {
      const label = match.groups?.['label'];
      if (label !== undefined) declared.add(label);
    }
  }
  if (declared.size === 0) {
    throw new Error(
      `${libraryDir} declares no OPAQUE protocol label — those literals are the only ` +
        `thing identifying the protocol stack in a built artifact, and without them the ` +
        `absence check passes on every bundle.`
    );
  }
  return [...declared];
}

/**
 * Vite's asset directory, where every chunk an SPA emits lands, and the SPA
 * shell beside it. Together they are the SPA's own half of a dist.
 *
 * Astro emits its chunks under a directory of its own, which is what separates
 * the merged marketing half of `apps/web`'s dist from the app's own half — in
 * both directions, and by construction rather than by any exemption.
 */
const SPA_CHUNK_DIR = 'assets/';
const SPA_SHELL = 'index.html';
const MARKETING_CHUNK_DIR = '_astro/';

/** onnxruntime-web runtime artifacts, wherever a bundler emitted them. */
const ORT_RUNTIME_FILE = /^ort-wasm.*\.(?:wasm|mjs)$/u;

/**
 * Bundler-emitted asset paths for the ORT wasm — the reference the extern-wasm
 * import condition exists to remove. A built chunk containing one means the
 * fat variant resolved again.
 */
const BUNDLED_ORT_REFERENCES = [`/${SPA_CHUNK_DIR}ort-`, `/${MARKETING_CHUNK_DIR}ort-`];

export interface BundleFile {
  /** Slash-separated, relative to the dist root. */
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly bytes: number;
}

export interface VerifyBundleOptions {
  readonly distributionDir: string;
  /**
   * Whether this bundle is expected to carry the TTS engine. Required rather
   * than defaulted: a default would be a second declaration of the answer that
   * `APPS_SHIPPING_TTS` already holds.
   */
  readonly shipsTts: boolean;
  /**
   * Defaults to the ORT runtime of the installed transformers — the same
   * resolution `ortAssetsPlugin` emits from, so the check compares the bundle
   * against exactly what the build was supposed to copy.
   */
  readonly ortAssets?: readonly OrtAsset[];
  /**
   * The generated env file of the stack the build was invoked for. Absent for a
   * caller that can name no stack: the command-line verifier runs over whatever
   * a directory holds, including the OTA dists, which a native build writes
   * with no generated file in reach at all.
   */
  readonly stackEnvFile?: string;
  /**
   * Whether this bundle answers HTTP requests. A statement about the bundle,
   * made by the caller that knows: the mobile release builds go into the
   * primary output directory and are then compiled into an application binary,
   * where a web view serves them and no origin exists. Absent, the output
   * directory's own name answers it, which is the weaker evidence left when
   * nobody says.
   */
  readonly servedOverHttp?: boolean;
}

/** The seam `build-web-bundle.ts` injects, so its tests need no real dist. */
export type VerifyBundle = (options: VerifyBundleOptions) => Promise<void>;

async function listBundleFiles(directory: string, prefix = ''): Promise<BundleFile[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: BundleFile[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await listBundleFiles(absolutePath, relativePath)));
      continue;
    }
    const stats = await fs.stat(absolutePath);
    files.push({ relativePath, absolutePath, bytes: stats.size });
  }
  return files;
}

async function sha256(filePath: string): Promise<string | null> {
  const bytes = await fs.readFile(filePath).catch(() => null);
  return bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
}

/**
 * The self-hosted runtime under `dist/ort/` must exist and be byte-identical to
 * the installed package — a stale or partial copy is a runtime 404 or a version
 * skew the browser only discovers on a user's first Listen.
 */
async function checkSelfHostedRuntime(
  distributionDir: string,
  assets: readonly OrtAsset[]
): Promise<string[]> {
  const violations: string[] = [];
  for (const asset of assets) {
    const relativePath = `${ORT_DIR}/${asset.fileName}`;
    const expected = await sha256(asset.absPath);
    const actual = await sha256(path.join(distributionDir, ORT_DIR, asset.fileName));
    if (actual === null) {
      violations.push(`missing self-hosted ORT runtime file: ${relativePath}`);
    } else if (actual !== expected) {
      violations.push(
        `self-hosted ORT runtime file does not match the installed package: ` +
          `${relativePath} (sha256 ${actual}, expected ${String(expected)})`
      );
    }
  }
  return violations;
}

function checkStrayRuntimeCopies(files: readonly BundleFile[]): string[] {
  return files
    .filter(
      (file) =>
        ORT_RUNTIME_FILE.test(path.posix.basename(file.relativePath)) &&
        !file.relativePath.startsWith(`${ORT_DIR}/`)
    )
    .map(
      (file) =>
        `redundant ORT runtime copy outside ${ORT_DIR}/: ` +
        `${file.relativePath} (${String(file.bytes)} B)`
    );
}

/**
 * Only `.js` is scanned: source maps legitimately name the bundler-emitted
 * asset in their `sources`, and flagging those would be a false positive.
 */
async function checkBundledRuntimeReferences(files: readonly BundleFile[]): Promise<string[]> {
  const violations: string[] = [];
  for (const file of files.filter((candidate) => candidate.relativePath.endsWith('.js'))) {
    const source = await fs.readFile(file.absolutePath, 'utf8');
    const reference = BUNDLED_ORT_REFERENCES.find((candidate) => source.includes(candidate));
    if (reference !== undefined) {
      violations.push(
        `built script references the bundler-emitted ORT asset "${reference}…": ` +
          `${file.relativePath} — the ORT runtime must load from ${ORT_DIR}/ only`
      );
    }
  }
  return violations;
}

/**
 * A quoted version literal. The backtick alternative is spelled out rather than
 * escaped: `\`` is an invalid identity escape under the `u` flag.
 */
const QUOTED_VERSION = '(?:`[^`]*`|\'[^\']*\'|"[^"]*")';

/**
 * onnxruntime reports its version through `versions: { common: … }` on its env
 * object, and a chunk carries one such site per ORT copy it embeds — the
 * externally-resolved `onnxruntime-common` module, plus the copy onnxruntime
 * inlines into its own pre-bundled `ort.min.mjs`. Sites that disagree mean two
 * onnxruntime versions shipped side by side.
 *
 * Minifiers hoist the literal into a local, so the bound value is either a
 * quoted string or an identifier to resolve in the same chunk. Lookbehind
 * rather than a capture group, so the match is `match[0]` — always present,
 * with no unreachable "group did not participate" branch to leave uncovered.
 */
const ORT_VERSION_SITE = new RegExp(
  String.raw`(?<=versions\s*:\s*\{\s*common\s*:\s*)` +
    String.raw`(?:${QUOTED_VERSION}|[A-Za-z_$][\w$]*)`,
  'gu'
);

const QUOTE = /^[`'"]/u;

/** Identifiers match `[A-Za-z_$][\w$]*`, so `$` is the only regex-special char. */
function escapeIdentifier(identifier: string): string {
  return identifier.replaceAll('$', () => String.raw`\$`);
}

function assignmentsTo(identifier: string): RegExp {
  return new RegExp(
    String.raw`(?<=(?<![\w$])${escapeIdentifier(identifier)}\s*=\s*)` + QUOTED_VERSION,
    'gu'
  );
}

/** The version a `versions.common` site reports, or null if it cannot be read. */
function resolveVersion(source: string, bound: string): string | null {
  if (QUOTE.test(bound)) {
    return bound.slice(1, -1);
  }
  const distinct = [
    ...new Set([...source.matchAll(assignmentsTo(bound))].map((match) => match[0].slice(1, -1))),
  ];
  // A minifier binds the literal exactly once; anything else means the local
  // being read is not the one holding the version.
  const [only] = distinct.length === 1 ? distinct : [];
  return only ?? null;
}

async function checkOrtCommonVersion(
  files: readonly BundleFile[],
  expected: string
): Promise<string[]> {
  const violations: string[] = [];
  let sites = 0;
  for (const file of files.filter((candidate) => candidate.relativePath.endsWith('.js'))) {
    const source = await fs.readFile(file.absolutePath, 'utf8');
    for (const site of source.matchAll(ORT_VERSION_SITE)) {
      sites += 1;
      const found = resolveVersion(source, site[0]);
      if (found === null) {
        violations.push(
          `cannot read the onnxruntime version bound at versions.common in ` +
            `${file.relativePath} (bound to \`${site[0]}\`) — the built output no ` +
            `longer has the shape this check reads, so it must not be trusted`
        );
      } else if (found !== expected) {
        violations.push(
          `shipped onnxruntime-common version is ${found}, expected ${expected}: ` +
            `${file.relativePath} — a copy other than the one the workspace's ` +
            `@huggingface/transformers package extension declares resolved instead (a ` +
            `transformers bump stops that extension applying, silently)`
        );
      }
    }
  }
  if (sites === 0) {
    violations.push(
      `no onnxruntime version site (versions.common) in any built script — ` +
        `either the bundle stopped shipping onnxruntime or this check no longer ` +
        `recognizes the built output, and it must not pass vacuously`
    );
  }
  return violations;
}

const WORKER_CHUNK = /^tts\.worker-.*\.js$/u;

/**
 * The identifier a bundler binds its synthesised `import.meta` stand-in to,
 * recognised by the declaration it always carries — an object literal holding
 * the module URL (`{ url: self.location.href }`). The name is not stable:
 * minification renames `_vite_importMeta` to whatever is free (`df` in the
 * marketing build), so a guard keyed to the literal name would stop guarding
 * the minified bundle, which is the one users get. Matched as `match[0]` via a
 * lookahead rather than a capture group, so there is no
 * "group did not participate" branch.
 */
const IMPORT_META_STANDIN = new RegExp(
  String.raw`(?<![\w$.])[A-Za-z_$][\w$]*` +
    String.raw`(?=\s*=\s*\{\s*url\s*:\s*(?:self\s*\.\s*)?location\s*\.\s*href\s*[,}])`,
  'gu'
);

function prototypeReadsOf(identifier: string): RegExp {
  return new RegExp(String.raw`(?<![\w$.])${escapeIdentifier(identifier)}\s*\.\s*prototype`, 'u');
}

/**
 * `@huggingface/transformers`' `Callable` base class — extended by every
 * tokenizer and processor — does `Object.setPrototypeOf(closure,
 * new.target.prototype)`. A worker transform that rewrites that `new.target`
 * into a synthesised `import.meta` stand-in leaves `.prototype` `undefined`, so
 * every worker dies on load with "Object prototype may only be an Object or
 * null: undefined". Dev serves the worker as a native ES module and never
 * applies a worker transform, so nothing but the built output can catch this.
 * Reading `.prototype` off the stand-in is never intentional — it is
 * `undefined` by construction — so the read itself is the signal, whatever
 * consumes it.
 *
 * Historical, not current: rolldown's iife worker format did exactly this
 * rewrite on 1.0.0-beta.53, which is why the check exists and why
 * `WORKER_BUILD_OPTIONS` pins `format: 'es'`. On 1.2.1 it no longer reproduces
 * — built both ways, `new.target` survives under `iife` too. The guard stays
 * because the corruption is invisible in dev and fatal in every built site, so
 * the cost of keeping it is a regex and the cost of being wrong is a dead TTS
 * worker in production. Confirming the old mechanism is gone is not grounds to
 * delete it.
 */
async function checkWorkerMetaProperty(files: readonly BundleFile[]): Promise<string[]> {
  const workers = files.filter((file) => WORKER_CHUNK.test(path.posix.basename(file.relativePath)));
  const violations: string[] = [];
  for (const file of workers) {
    const source = await fs.readFile(file.absolutePath, 'utf8');
    const standins = [...source.matchAll(IMPORT_META_STANDIN)].map((match) => match[0]);
    for (const standin of new Set(standins)) {
      if (prototypeReadsOf(standin).test(source)) {
        violations.push(
          `built TTS worker reads \`${standin}.prototype\` off the bundler's ` +
            `import.meta stand-in: ${file.relativePath} — the iife worker transform ` +
            `rewrote \`new.target\` as \`import.meta\`, so every worker throws ` +
            `"Object prototype may only be an Object or null: undefined" on load`
        );
      }
    }
  }
  if (workers.length === 0) {
    violations.push(
      `no tts.worker-*.js chunk in the bundle — either the build stopped ` +
        `emitting the TTS worker or this check no longer recognizes it, and it ` +
        `must not pass vacuously`
    );
  }
  return violations;
}

/**
 * The whole expectation for a bundle declared TTS-free: neither the worker
 * chunk nor any ORT runtime file exists. The engine is unreachable from the
 * app's module graph or it is not — there is no partial state, because the
 * worker is emitted from the `new Worker(new URL(…))` site at transform time
 * and pulls its runtime with it.
 */
function checkNoTtsArtifacts(files: readonly BundleFile[]): string[] {
  return files
    .filter((file) => {
      const name = path.posix.basename(file.relativePath);
      return WORKER_CHUNK.test(name) || ORT_RUNTIME_FILE.test(name);
    })
    .map(
      (file) =>
        `TTS artifact in a bundle declared TTS-free: ${file.relativePath} ` +
        `(${String(file.bytes)} B) — something in this app's module graph reaches ` +
        `the TTS engine, and the bundler emits the worker before tree-shaking`
    );
}

/**
 * Where executable text can sit in a shipped origin: emitted chunks, and the
 * pages that carry script inline. Nothing else in a dist is read as code, and
 * source maps are excluded for the reason they always are — they name the
 * source their chunk was built from, so scanning them reports the chunk twice.
 *
 * This is the reach of a check about code. A check about what the origin serves
 * has a wider one and must not borrow this: see {@link readTextFile}.
 */
const EXECUTABLE_TEXT = /\.(?:js|mjs|html)$/u;

/**
 * How much of a file settles whether it is binary.
 *
 * A NUL byte near the start is what every text tool reads as binary, and taking
 * that from a prefix doubles as the early-out keeping a wasm payload off the
 * read path. It is not the whole answer — a binary carrying no NUL there is
 * caught by the decode instead, which is why the two are not interchangeable
 * and neither is redundant.
 */
const BINARY_SNIFF_BYTES = 8192;

/**
 * A file's text, or `null` where the bytes are not text at all.
 *
 * Read off the bytes rather than off the name, because the question this
 * answers is what a public origin serves as text, and a name list answers a
 * different one: it was once `.js`, `.mjs` and `.html`, and the only match in
 * the whole shipped tree sat in `_headers`, which the list did not name. A
 * response-header file, a manifest, a feed and a search index are all as
 * readable to a visitor as a chunk is, and each arrives whenever a build starts
 * emitting it, under whatever name that build chooses.
 */
async function readTextFile(absolutePath: string): Promise<string | null> {
  const handle = await fs.open(absolutePath, 'r');
  try {
    const head = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(head, 0, BINARY_SNIFF_BYTES, 0);
    if (head.subarray(0, bytesRead).includes(0)) return null;
  } finally {
    await handle.close();
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(absolutePath));
  } catch {
    return null;
  }
}

/**
 * No public origin may serve backend environment material. The registry's own
 * shape is one way it arrives; the Zod schema restating a subset of the
 * registry's entry names is the other, and that one reached the web,
 * marketing, admin and OTA bundles through a barrel import while every gate
 * on the tree stayed green — the detector reads both, derived from the
 * registry so a new entry needs no edit here.
 *
 * Every text file in the dist, not the executable ones alone: the promise is
 * about what the origin serves, and serving material as data leaks it exactly
 * as serving it as code does. {@link readTextFile} decides which files those
 * are.
 */
async function checkEnvRegistryContent(files: readonly BundleFile[]): Promise<string[]> {
  const violations: string[] = [];
  for (const file of files) {
    const source = await readTextFile(file.absolutePath);
    if (source === null) continue;
    const found = envRegistryContentIn(source);
    if (found.length > 0) {
      violations.push(
        `built artifact carries backend environment material: ${file.relativePath} — ` +
          found.join(', ')
      );
    }
  }
  return violations;
}

/**
 * The push-only service worker's build plugin. Read for the name it emits the
 * worker under rather than restating it, so a rename there cannot leave this
 * check opening a file no build writes.
 */
const SERVICE_WORKER_PLUGIN_MODULE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../apps/web/src/lib/platform/service-worker-build-plugin.ts'
);

/** The lib build's emitted-name declaration, whichever quote style it is written in. */
const SERVICE_WORKER_FILE_NAME_DECLARATION =
  /\bfileName\s*:\s*\(\)\s*=>\s*(['"])(?<name>[^'"]+)\1/u;

/**
 * The unhashed name the service worker is emitted under, at the root of
 * whichever dist the build wrote. The worker is a second, self-contained lib
 * build, so it lands beside the app's chunk directory rather than inside it.
 *
 * @param pluginModule module carrying the declaration; the default is the real one.
 */
export async function declaredServiceWorkerFileName(
  pluginModule: string = SERVICE_WORKER_PLUGIN_MODULE
): Promise<string> {
  const source = await fs.readFile(pluginModule, 'utf8');
  const declared = SERVICE_WORKER_FILE_NAME_DECLARATION.exec(source)?.groups?.['name'];
  if (declared === undefined) {
    throw new Error(
      `${pluginModule} must declare the file name it emits the service worker under — ` +
        `that name is how a check finds the worker in a built artifact, and without it ` +
        `every assertion about the worker's contents passes on a file nothing opened.`
    );
  }
  return declared;
}

/**
 * The signed-in app must never name the growth beacon, and this is the layer
 * that reads the artifact: the source sweep in `apps/web` sees what the app
 * writes, while a beacon reaching a chunk through a workspace package that no
 * app module names is visible only here, after tree-shaking has decided what
 * actually ships.
 *
 * The reach is the app's own artifacts rather than every text file, because
 * `apps/web`'s dist is the merged web + marketing bundle and the marketing
 * pages are exactly where the beacon belongs. Reading them would fail every
 * bundle built once the script ships. Marketing's output collides with none of
 * these three: its chunks sit under their own prefix, its pages under their
 * route prefixes, and it emits no service worker.
 *
 * The worker earns its place beside the shell and the chunks rather than being
 * covered by them: it is emitted unhashed at the dist root by a second lib
 * build that declares module side effects away, so it both sits outside the
 * chunk directory and keeps a different subset of any package it imports.
 */
async function checkGrowthBeacon(
  files: readonly BundleFile[],
  serviceWorkerFileName: string
): Promise<string[]> {
  const appArtifact = (relativePath: string): boolean =>
    relativePath === SPA_SHELL ||
    relativePath === serviceWorkerFileName ||
    relativePath.startsWith(SPA_CHUNK_DIR);
  const violations: string[] = [];
  for (const file of files) {
    if (!appArtifact(file.relativePath)) continue;
    const source = await readTextFile(file.absolutePath);
    if (source === null) continue;
    const found = growthBeaconReferencesIn(source);
    if (found.length > 0) {
      violations.push(
        `built app artifact names the growth beacon: ${file.relativePath} — ${found.join(', ')}`
      );
    }
  }
  return violations;
}

/**
 * The public marketing site must not ship the OPAQUE protocol stack. It
 * authenticates nobody: the pages are anonymous, and the one component reaching
 * into the crypto package wants message encryption. The stack arrives anyway
 * whenever a module graph reaches a door that re-exports it, because the
 * protocol configuration runs at module top level and the vendored field
 * arithmetic under it has top-level statements of its own — so no tree-shaking
 * configuration removes it, and only not reaching those modules does.
 *
 * Scoped to the marketing chunk directory, which is the whole of the mechanism
 * keeping the app's own auth chunk out of it: `apps/web` authenticates over
 * OPAQUE and emits its chunks under its own directory, so the two halves of the
 * merged dist never overlap and no exemption is needed for either.
 */
async function checkMarketingOpaqueStack(
  files: readonly BundleFile[],
  labels: readonly string[]
): Promise<string[]> {
  const violations: string[] = [];
  const marketingChunks = files.filter(
    (file) =>
      file.relativePath.startsWith(MARKETING_CHUNK_DIR) && EXECUTABLE_TEXT.test(file.relativePath)
  );
  for (const file of marketingChunks) {
    const source = await fs.readFile(file.absolutePath, 'utf8');
    const found = labels.filter((label) => source.includes(label));
    if (found.length > 0) {
      violations.push(
        `marketing chunk carries the OPAQUE protocol stack: ${file.relativePath} — ` +
          found.join(', ')
      );
    }
  }
  return violations;
}

/**
 * Every pre-paint bootstrap script has to reach the shell a built SPA serves.
 * One plugin registration in an app's Vite config is what puts them there, so
 * the defect this catches is a config that never registered it: the shell
 * paints the default theme with no accessibility adjustments and jumps to the
 * stored ones after mount, which is precisely the flash the scripts exist to
 * prevent, and nothing else on the tree reports it. The end-to-end suite reads
 * those classes only after mount, so it cannot.
 *
 * Keyed on the shell being present rather than on a per-app declaration: an
 * origin verified here that serves no SPA has no `index.html` to begin with —
 * the document sandbox names each page after what it renders.
 */
async function checkPrePaintShell(files: readonly BundleFile[]): Promise<string[]> {
  const shell = files.find((file) => file.relativePath === SPA_SHELL);
  if (shell === undefined) return [];
  const source = await fs.readFile(shell.absolutePath, 'utf8');
  return [...PRE_PAINT_SCRIPTS]
    .filter(([, script]) => !source.includes(script.trim()))
    .map(
      ([name]) =>
        `built SPA shell carries no ${name} pre-paint script: ${SPA_SHELL} — this app's ` +
        `vite config does not register the pre-paint plugin`
    );
}

/**
 * The frontend flag only an E2E build bakes: the apps/web Vite config imports
 * this rather than typing the name a second time, so a rename cannot leave the
 * build reading one entry while this file guards another. The app-side readers
 * of the flag hand-type it and have to be renamed by hand, with nothing failing
 * when one is missed. Typed against the registry so the rename at least fails
 * the typecheck here rather than silently disabling
 * {@link checkE2eDeviceKeyStore}.
 */
export const E2E_BUILD_FLAG_NAME: keyof typeof envConfig = 'VITE_E2E';

/**
 * The value the apps/web Vite config requires before it installs the store's
 * E2E resolver — read out of the registry that declares it, the same registry
 * this file already binds the flag's *name* to. A value written down here
 * instead would be a second declaration that has to keep agreeing with the
 * first to keep {@link checkE2eDeviceKeyStore} pointed at real E2E builds.
 *
 * Resolved through the registry's own ref-following resolver, so an entry
 * expressing its E2E value as a reference to another mode yields that mode's
 * literal and not the reference object. E2E mode is where the flag is declared
 * and what a CI E2E build refs.
 *
 * No fallback: an entry resolving to no literal leaves nothing that can tell a
 * real E2E build from a production one, and a value invented here would switch
 * {@link checkE2eDeviceKeyStore} off for bundles the resolver did touch.
 *
 * @param entry registry entry carrying the flag; the default is the real one.
 */
export function requiredE2eBuildFlagValue(
  entry: VariableConfig = envConfig[E2E_BUILD_FLAG_NAME]
): string {
  const resolved = resolveRaw(entry, Mode.E2E);
  if (resolved === undefined || isSecret(resolved)) {
    throw new Error(
      `${E2E_BUILD_FLAG_NAME} must resolve to a literal value in ${Mode.E2E} mode — that value ` +
        `is the only thing separating an E2E bundle from a production one here, and ` +
        `without it the E2E device-key store check cannot tell which bundles it may exempt.`
    );
  }
  return resolved;
}

/**
 * The quote characters a string literal can arrive under. A minified build
 * emits the inlined env values as template literals, so the backtick sits here
 * beside the ordinary quotes.
 */
const STRING_QUOTE_CHARS = '\'"`';

const STRING_QUOTE = `[${STRING_QUOTE_CHARS}]`;

/**
 * The flag in object-key position at whatever string literal follows it, as a
 * bundler emits the inlined `import.meta.env`. Anchored on its left so a longer
 * entry name ending in this one cannot pass for it, and closed with the quote
 * it opened with. The literal's text is captured for
 * {@link bakesE2eBuildFlag} to compare, never spliced in.
 *
 * Global because a chunk can bake the flag more than once and every occurrence
 * has to be looked at; `matchAll` also refuses a non-global pattern. It reads
 * `lastIndex` without writing it, so this one pattern carries no state between
 * calls.
 */
const E2E_BUILD_FLAG_BAKED = new RegExp(
  String.raw`(?<![\w$])${STRING_QUOTE}?${E2E_BUILD_FLAG_NAME}${STRING_QUOTE}?\s*:\s*` +
    String.raw`(?<quote>${STRING_QUOTE})(?<baked>[^${STRING_QUOTE_CHARS}]*)\k<quote>`,
  'gu'
);

/**
 * Whether a built artifact's text bakes the flag at the value the registry
 * declares — the condition that tells {@link checkE2eDeviceKeyStore} it is
 * looking at a real E2E build and may stand down.
 *
 * The value is compared, never interpolated into the pattern: a registry value
 * carrying regex metacharacters would otherwise widen what the pattern accepts,
 * and widening what counts as an E2E build here suppresses the assertion for
 * bundles it must still hold over.
 *
 * @param source executable text out of one built file.
 * @param requiredValue the value marking an E2E build; the default is the registry's.
 */
export function bakesE2eBuildFlag(
  source: string,
  requiredValue: string = requiredE2eBuildFlagValue()
): boolean {
  return [...source.matchAll(E2E_BUILD_FLAG_BAKED)].some(
    (match) => match.groups?.['baked'] === requiredValue
  );
}

/** Every executable file's text, keyed by its path in the dist. */
async function executableSources(files: readonly BundleFile[]): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  for (const file of files.filter((candidate) => EXECUTABLE_TEXT.test(candidate.relativePath))) {
    sources.set(file.relativePath, await fs.readFile(file.absolutePath, 'utf8'));
  }
  return sources;
}

/**
 * The files carrying any of `markers`, unless the bundle proves itself an E2E
 * build. Shared by every module the build picks by flag: source-level guards on
 * one reason about which module *should* resolve, and only the artifact says
 * which one did.
 *
 * Module and build are indistinguishable in this dimension — a resolver
 * mistakenly installed in a production build emits exactly the artifact a real
 * E2E build does — so the E2E flag that same build bakes is the only thing
 * separating them. The gate fails closed: a production dist never carries the
 * flag, so the assertions keep full strength there, while an E2E dist that
 * stopped carrying it would fail its own build loudly instead of weakening them.
 */
async function e2eOnlyModuleCarriers(
  files: readonly BundleFile[],
  markers: readonly string[]
): Promise<string[]> {
  const sources = await executableSources(files);
  const carrying = [...sources].filter(([, source]) =>
    markers.some((marker) => source.includes(marker))
  );
  if (carrying.length === 0) return [];
  if ([...sources.values()].some((source) => bakesE2eBuildFlag(source))) return [];
  return carrying.map(([relativePath]) => relativePath);
}

/** The plaintext export-key store belongs in no bundle but an E2E one. */
async function checkE2eDeviceKeyStore(
  files: readonly BundleFile[],
  markers: readonly string[]
): Promise<string[]> {
  const carriers = await e2eOnlyModuleCarriers(files, markers);
  return carriers.map(
    (relativePath) =>
      `E2E device-key store in a bundle that is not an E2E build: ${relativePath} — ` +
      `this variant persists the export key as plaintext in localStorage, so the ` +
      `device key ships readable to anything that can run script on the origin`
  );
}

/**
 * The fixed-answer predictor belongs in no bundle but an E2E one either. What
 * ships wrong here is smaller than the store above — the stub answers nothing
 * until a specific localStorage key is set, so a stray copy sits inert for a
 * real user — but which module a flag picked is still readable only here.
 */
async function checkE2ePromptPredictorStub(
  files: readonly BundleFile[],
  markers: readonly string[]
): Promise<string[]> {
  const carriers = await e2eOnlyModuleCarriers(files, markers);
  return carriers.map(
    (relativePath) =>
      `E2E prompt-predictor stub in a bundle that is not an E2E build: ${relativePath} — ` +
      `this variant answers the composer with fixed text and never loads a model, so the ` +
      `build resolved the wrong predictor`
  );
}

/**
 * A warning only React DOM's development client carries. A string literal
 * survives minification, so it identifies that build in a minified chunk as in
 * a readable one. This module's tests measure it against the installed client.
 */
export const REACT_DEVELOPMENT_BUILD_MARKER = 'Encountered two children with the same key';

/**
 * Whether a file is one of the marketing site's chunks, at any depth: the admin
 * origin serves its framed copy of the site under a path prefix.
 */
function inMarketingChunkDir(relativePath: string): boolean {
  return (
    relativePath.startsWith(MARKETING_CHUNK_DIR) || relativePath.includes(`/${MARKETING_CHUNK_DIR}`)
  );
}

/**
 * An app's own chunks carry React's production build in every build, and an
 * E2E build's marketing islands carry the development build.
 *
 * The apps mount with `createRoot` and never hydrate, so the development build
 * adds them nothing but diagnostics the users' build lacks; their Vite configs
 * pin the production build for every `vite build`, and the E2E flag exempts
 * nothing here. The marketing islands hydrate, and the development build's
 * hydration attribute comparison is the suite's only hydration check, so an E2E
 * build whose islands lost it would run the suite with that check disarmed.
 */
async function checkReactBuild(files: readonly BundleFile[]): Promise<string[]> {
  const sources = await executableSources(files);
  const carriers = [...sources]
    .filter(([, source]) => source.includes(REACT_DEVELOPMENT_BUILD_MARKER))
    .map(([relativePath]) => relativePath);
  const violations = carriers
    .filter((relativePath) => !inMarketingChunkDir(relativePath))
    .map(
      (relativePath) =>
        `app chunk carries React's development build: ${relativePath} — an app's own ` +
        `chunks ship the production build its users run`
    );
  const isE2eBuild = [...sources.values()].some((source) => bakesE2eBuildFlag(source));
  if (isE2eBuild && !carriers.some((relativePath) => inMarketingChunkDir(relativePath))) {
    violations.push(
      `E2E build with no marketing island under ${MARKETING_CHUNK_DIR} on React's development ` +
        `build — the suite's hydration check runs only there`
    );
  }
  return violations;
}

/**
 * The prefix this comparison covers: the one a generated frontend env file
 * writes its entries under. An entry under any other prefix sits outside the
 * comparison entirely — declared on one side or baked on the other, it is
 * checked against nothing here.
 */
const FRONTEND_ENV_PREFIX = 'VITE_';

/** A written value under the quote pair the generator wrapped it in, if it wrapped one. */
const QUOTED_ENV_VALUE = /^(['"])(.*)\1$/u;

/** Where the text inside that pair sits in a match of it. */
const QUOTED_ENV_TEXT = 2;

/**
 * A generated value as the loader that baked it reads one: the surrounding
 * quote pair is the generator's escaping, and the contents are taken verbatim.
 * Read this way rather than unescaped, because what the file supplies a loader
 * is what the build had to bake.
 */
function loadedEnvValue(raw: string): string {
  return QUOTED_ENV_VALUE.exec(raw)?.[QUOTED_ENV_TEXT] ?? raw;
}

/**
 * What the generator wrote for the stack a build was invoked for, read out of
 * the file it wrote it to.
 *
 * Derived rather than written down: a list of the values that vary between
 * stacks would be a closed set, and would stop covering a value on the day the
 * registry gains one — which is the failure this comparison exists to catch.
 *
 * @param envFile the generated frontend env file, absolute. A missing one
 *   throws rather than yielding an empty set, which would pass every bundle.
 */
export async function declaredStackEnvValues(envFile: string): Promise<Map<string, string>> {
  const source = await fs.readFile(envFile, 'utf8');
  const declared = new Map<string, string>();
  for (const line of source.split('\n')) {
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    if (!key.startsWith(FRONTEND_ENV_PREFIX)) continue;
    declared.set(key, loadedEnvValue(line.slice(separator + 1).trim()));
  }
  return declared;
}

/**
 * A frontend variable in object-key position at the literal a bundler inlined
 * it to, as both an unminified build (quoted key, quoted value) and a minified
 * one (bare key, template literal) emit it. Anchored on its left so a longer
 * identifier ending in a variable's name cannot pass for one.
 *
 * Global because every chunk that reads the environment bakes the whole object
 * and each occurrence has to be looked at; `matchAll` also refuses a non-global
 * pattern.
 */
const BAKED_FRONTEND_VALUE = new RegExp(
  String.raw`(?<![\w$])(?<keyQuote>${STRING_QUOTE})?(?<key>${FRONTEND_ENV_PREFIX}[A-Z0-9_]+)` +
    String.raw`\k<keyQuote>?\s*:\s*(?<quote>${STRING_QUOTE})(?<baked>[^${STRING_QUOTE_CHARS}]*)\k<quote>`,
  'gu'
);

/**
 * Holds the bundle to the stack the build was invoked for: what it bakes
 * against what the generator wrote for that stack, in both directions.
 *
 * The build derives its mode from one stack selector and the generated file is
 * its sole supply, so under the restructure this holds trivially — which is
 * exactly what makes it cheap to keep and meaningful when it fires: a bundle
 * carrying another stack's addresses is invisible until a user meets it.
 *
 * Violations name the values. Every one of them is a value the bundle already
 * serves to anyone who loads it, so naming one discloses nothing the artifact
 * does not.
 */
async function checkStackEnvValues(
  files: readonly BundleFile[],
  declared: ReadonlyMap<string, string>
): Promise<string[]> {
  const baked = await bakedFrontendValues(files);
  const violations = [...baked].flatMap(([key, carriers]) =>
    bakedValueViolations(key, carriers, declared.get(key))
  );
  for (const key of declared.keys()) {
    if (!baked.has(key)) {
      violations.push(
        `no built artifact bakes ${key}, which the stack this build was invoked for ` +
          `declares — nothing in this bundle read the generated environment file`
      );
    }
  }
  return violations;
}

/**
 * Every frontend value the bundle bakes, by variable and then by value, at the
 * files carrying each.
 *
 * The carriers are a set: a chunk that reads the environment bakes the whole
 * object, a bundler emits that object more than once in one chunk, and listing
 * a file once per occurrence tells a reader nothing it can act on.
 */
async function bakedFrontendValues(
  files: readonly BundleFile[]
): Promise<Map<string, Map<string, Set<string>>>> {
  const baked = new Map<string, Map<string, Set<string>>>();
  for (const file of files.filter((candidate) => EXECUTABLE_TEXT.test(candidate.relativePath))) {
    const source = await fs.readFile(file.absolutePath, 'utf8');
    for (const match of source.matchAll(BAKED_FRONTEND_VALUE)) {
      const key = match.groups?.['key'] ?? '';
      const value = match.groups?.['baked'] ?? '';
      const carriers = baked.get(key) ?? new Map<string, Set<string>>();
      carriers.set(value, (carriers.get(value) ?? new Set<string>()).add(file.relativePath));
      baked.set(key, carriers);
    }
  }
  return baked;
}

/** What one baked variable's values are, against the one value the stack declares for it. */
function bakedValueViolations(
  key: string,
  carriers: ReadonlyMap<string, ReadonlySet<string>>,
  expected: string | undefined
): string[] {
  return [...carriers]
    .filter(([value]) => value !== expected)
    .map(([value, carrying]) =>
      expected === undefined
        ? `built artifact bakes ${key}="${value}", which the stack this build was invoked ` +
          `for declares nothing for: ${[...carrying].join(', ')} — this build read some ` +
          `other stack's generated environment file`
        : `built artifact bakes ${key}="${value}" where the stack this build was invoked ` +
          `for declares "${expected}": ${[...carrying].join(', ')}`
    );
}

/** Cloudflare reads response headers for a static origin from this file. */
const HEADERS_FILE = '_headers';

/**
 * Every origin gets its `_headers` from a build step: admin's `closeBundle`
 * hook emits it, the sandbox copies it out of `public/`, and the web bundle's
 * is written by a generator the build runs before this check. Dropping that
 * step costs the origin its CSP and every other security header, with no other
 * symptom until someone reads a response.
 */
function checkHeadersFile(files: readonly BundleFile[]): string[] {
  if (files.some((file) => file.relativePath === HEADERS_FILE)) {
    return [];
  }
  return [
    `no ${HEADERS_FILE} at the dist root — this origin ships without its CSP and the ` +
      `rest of its security headers`,
  ];
}

export function checkPagesLimits(files: readonly BundleFile[]): string[] {
  const violations = files
    .filter((file) => file.bytes > PAGES_MAX_FILE_BYTES)
    .map(
      (file) =>
        `over Cloudflare Pages' per-file cap: ${file.relativePath} ` +
        `(${String(file.bytes)} B, cap ${String(PAGES_MAX_FILE_BYTES)} B)`
    );
  if (files.length > PAGES_MAX_FILE_COUNT) {
    violations.push(
      `over Cloudflare Pages' per-deployment file cap: ${String(files.length)} files ` +
        `(cap ${String(PAGES_MAX_FILE_COUNT)})`
    );
  }
  return violations;
}

export async function collectBundleViolations(options: VerifyBundleOptions): Promise<string[]> {
  const files = await listBundleFiles(options.distributionDir);
  // A response-header file means something only where a response exists. A
  // bundle packaged into an application — the OTA dists, and the primary dist a
  // mobile release build compiles into its binary — answers no request, so the
  // requirement would be asserting about nothing. The caller's statement
  // decides it wherever there is one, and the dist name only where there is not.
  const servedOverHttp =
    options.servedOverHttp ?? path.basename(options.distributionDir) === PRIMARY_DIST_DIR;
  const headerChecks = servedOverHttp ? checkHeadersFile(files) : [];
  // Only a merged dist has a marketing half to read; anywhere else this matches
  // no file, which is the same answer as a dist whose marketing half is clean.
  const marketingChecks = await checkMarketingOpaqueStack(
    files,
    await declaredOpaqueProtocolLabels()
  );
  // Skipped, never defaulted, for a caller that names no stack: a stack picked
  // here would be this file's answer to what the build was invoked for, and the
  // command that ran the build is the only thing that knows.
  const stackEnvChecks =
    options.stackEnvFile === undefined
      ? []
      : await checkStackEnvValues(files, await declaredStackEnvValues(options.stackEnvFile));
  if (!options.shipsTts) {
    // Every ORT and worker check below presupposes the engine is present: the
    // self-hosted check requires a `dist/ort/` tree, and two others fail
    // deliberately on an empty match set so they cannot pass vacuously. The
    // zero-artifact assertion replaces all four and is strictly stronger — a
    // bundle with no ORT file can carry neither a stray copy of one nor a
    // chunk referencing one, since the reference is what emits the asset.
    return [
      ...checkNoTtsArtifacts(files),
      ...(await checkEnvRegistryContent(files)),
      ...(await checkGrowthBeacon(files, await declaredServiceWorkerFileName())),
      ...(await checkE2eDeviceKeyStore(files, await declaredE2eDeviceKeyMarkers())),
      ...(await checkE2ePromptPredictorStub(files, await declaredE2ePredictorMarkers())),
      ...(await checkReactBuild(files)),
      ...(await checkPrePaintShell(files)),
      ...stackEnvChecks,
      ...headerChecks,
      ...marketingChecks,
      ...checkPagesLimits(files),
    ];
  }
  const assets = options.ortAssets ?? resolveOrtAssets();
  return [
    ...(await checkSelfHostedRuntime(options.distributionDir, assets)),
    ...checkStrayRuntimeCopies(files),
    ...(await checkBundledRuntimeReferences(files)),
    ...(await checkOrtCommonVersion(files, await declaredOrtCommonVersion())),
    ...(await checkWorkerMetaProperty(files)),
    ...(await checkEnvRegistryContent(files)),
    ...(await checkGrowthBeacon(files, await declaredServiceWorkerFileName())),
    ...(await checkE2eDeviceKeyStore(files, await declaredE2eDeviceKeyMarkers())),
    ...(await checkE2ePromptPredictorStub(files, await declaredE2ePredictorMarkers())),
    ...(await checkReactBuild(files)),
    ...(await checkPrePaintShell(files)),
    ...stackEnvChecks,
    ...headerChecks,
    ...marketingChecks,
    ...checkPagesLimits(files),
  ];
}

export async function verifyBundle(options: VerifyBundleOptions): Promise<void> {
  const violations = await collectBundleViolations(options);
  if (violations.length > 0) {
    throw new Error(
      `Bundle verification failed (${options.distributionDir}):\n` +
        violations.map((violation) => `  - ${violation}`).join('\n')
    );
  }
}

/**
 * Marks that a CLI run already owns this process.
 *
 * The build-target check resolves `apps/admin/vite.config.ts`, that config
 * imports this module, and Vite's config loader bundles and re-evaluates it —
 * so the entry guard below fires a second time with the same `argv[1]` and the
 * CLI calls itself until the heap dies. The marker lives on `globalThis`
 * because each re-evaluation gets a fresh module scope but the same process.
 */
const CLI_RUNNING = Symbol.for('hushbox.verify-bundle.cli-running');
type CliHost = typeof globalThis & { [CLI_RUNNING]?: true };

/** How a caller states that the bundles it names answer no HTTP request. */
const NOT_SERVED_OVER_HTTP = '--not-served-over-http';

/**
 * What the command line states about the bundles it names, as an addition to
 * the options every other source fills in. A statement about the bundle rather
 * than a switch over the checks: the caller says how the bundle reaches its
 * reader, and what follows from that stays this file's to decide. Saying
 * nothing leaves the answer to {@link collectBundleViolations}.
 */
export function httpDeliveryStatement(
  flags: FlagRecord
): Pick<VerifyBundleOptions, 'servedOverHttp'> {
  return flags[NOT_SERVED_OVER_HTTP] === true ? { servedOverHttp: false } : {};
}

/**
 * The one mode a shipping bundle is built under, and so the one these checks
 * have anything to read: they compare built artifacts against the configs and
 * the generated values that build resolved.
 */
const SHIPPING_BUILD_MODE: EnvMode = Mode.Production;

/** Whether a run under `mode` has a shipping bundle to check. */
export function shipsBundlesIn(mode: EnvMode): boolean {
  return mode === SHIPPING_BUILD_MODE;
}

/**
 * What a run under a mode that builds no shipping bundle reports in place of a
 * verdict.
 *
 * The mode is the whole question, and it is asked of the mode rather than of
 * any value the mode carries: a run that asked whether some production value
 * had reached it would report on the machine it ran on instead of on the build
 * it was pointed at, and would pass for the wrong reason on a developer's
 * checkout that happened to hold one.
 */
export function noShippingBundlesNotice(mode: EnvMode): string {
  return (
    `Bundle verification does not apply in ${mode} mode: every check here reads a shipping ` +
    `build — the configs resolved under ${SHIPPING_BUILD_MODE} values, and the artifacts ` +
    `that build emits — and no other mode produces one. Nothing was verified.`
  );
}

export const COMMAND_LINE = {
  command: 'pnpm verify:bundle',
  summary: 'Checks the built bundles against what the shipping configs declare.',
  flags: [
    {
      flag: '--update',
      kind: 'boolean',
      summary: 'Write the derived deployment target into the generated project.',
    },
    {
      flag: NOT_SERVED_OVER_HTTP,
      kind: 'boolean',
      summary: 'State that these bundles are packaged into an application, not served.',
    },
  ],
  positionals: {
    kind: 'many',
    placeholder: '<dist-dir>',
    summary: 'Which built directories to verify. Defaults to the primary one.',
  },
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI entry point exercised via the verify:bundle package script */
if (isMainModule(import.meta.url) && (globalThis as CliHost)[CLI_RUNNING] !== true) {
  (globalThis as CliHost)[CLI_RUNNING] = true;
  await runMain(async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const parsed = readCommandLine(COMMAND_LINE, process.argv.slice(2));
    if (parsed === null) return;

    // The Xcode project is a generated artifact from here down: `--update`
    // writes the derived deployment target into it, and a plain run fails when
    // the committed value has moved away from it.
    if (parsed.flags['--update']) {
      writeDeploymentTarget(repoRoot);
      console.log(`Generated the deployment target into ${IOS_PROJECT_PATH}`);
      return;
    }

    const mode = envModeOrDefault(process.env);
    if (!shipsBundlesIn(mode)) {
      console.log(noShippingBundlesNotice(mode));
      return;
    }

    // Repo-wide, so it runs once per invocation rather than per dist: it reads
    // the shipping configs, not the directory being verified.
    const targetViolations = [
      ...(await collectBuildTargetViolations(repoRoot)),
      ...collectDeploymentTargetViolations(repoRoot),
    ];
    if (targetViolations.length > 0) {
      throw new Error(
        `Build target verification failed:\n` +
          targetViolations.map((violation) => `  - ${violation}`).join('\n')
      );
    }
    console.log('Verified the pinned build target');
    const delivery = httpDeliveryStatement(parsed.flags);
    for (const distributionDirName of requestedDistributionDirectories(parsed.positionals)) {
      const options = {
        ...appBundleOptions(repoRoot, 'apps/web', distributionDirName),
        ...delivery,
      };
      await verifyBundle(options);
      console.log(`Verified ${options.distributionDir}`);
    }
  });
}
/* v8 ignore stop */
