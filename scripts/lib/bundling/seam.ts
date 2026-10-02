/**
 * The build-config seam: values whose correctness depends on being identical
 * across build surfaces, written once here and imported rather than restated
 * per app.
 */
import { createRequire } from 'node:module';
import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ORT_WASM_PATH } from '../../../packages/shared/src/platform/ort-runtime.ts';
import type { Plugin } from 'vite';

export interface OrtAsset {
  readonly fileName: string;
  readonly absPath: string;
}

/**
 * The transpile target for every app build that ships JavaScript to a browser.
 *
 * Pinned rather than left on Vite's `baseline-widely-available` default, which
 * upstream re-generates on each Vite major. Inheriting that default silently
 * raises the syntax floor of the shipped bundle — the Safari/iOS entries are
 * the load-bearing ones, because the Capacitor WebView is bound to the OS
 * Safari version. Which devices still run the app is a product decision, not a
 * side effect of a bundler upgrade, which is why the browser entries stayed
 * where they were when the Apple ones moved.
 *
 * `safari16.4`/`ios16.4` are the source of `IPHONEOS_DEPLOYMENT_TARGET` in the
 * iOS project, which `verify-bundle.ts` generates from the `ios` entry here and
 * fails on when the committed project has drifted. The two must agree in both
 * directions: a lower deployment target installs the app on a device that cannot
 * parse what this emits, and a lower build target ships lowered syntax nobody
 * needs. Moving this list moves the Xcode project with it.
 *
 * It lives here because it must be identical across every shipping build, and
 * the failure mode when one build misses it is silent: that build simply emits
 * newer syntax and nothing reports it. Import this; never restate the list in
 * an app config. `verify-bundle.ts` holds the gate that proves each shipping
 * build actually emits at this floor.
 */
export const BUILD_TARGET: string[] = [
  'chrome107',
  'edge107',
  'firefox104',
  'safari16.4',
  'ios16.4',
];

// packages/ui owns the TTS engine (its dep tree carries kokoro-js →
// @huggingface/transformers). Anchor resolution there so it works regardless of
// which app's build invokes the plugin.
const UI_PACKAGE_JSON = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../packages/ui/package.json'
);

// `ORT_WASM_PATH` is the same-origin URL prefix each worker points the ORT
// runtime at (e.g. `/ort/`). Files serve/emit under the same directory.
export const ORT_DIR = ORT_WASM_PATH.replaceAll(/^\/+|\/+$/gu, '');

/**
 * onnxruntime-web's exports map offers this sibling import condition, which
 * resolves to the `dist/ort.min.mjs` build variant carrying zero
 * `new URL("ort-wasm-….wasm", import.meta.url)` references. Without it the
 * default variant resolves and every bundler that sees the TTS worker
 * statically emits its own ~21 MB copy of the wasm — one per app build.
 *
 * Its consumer contract is "self-host the .mjs/.wasm and set `wasmPaths`",
 * which `ortAssetsPlugin` below and `tts.worker.ts` already satisfy, so the
 * copies are pure waste. Added by microsoft/onnxruntime PR #24014; it is
 * documented nowhere else, including onnxruntime's own docs, so it reads as
 * mystery config without this note. Fails safe: if the condition ever stops
 * resolving, the default fat-but-working variant comes back.
 *
 * Applied via `resolve.conditions` in `apps/web/vite.config.ts` and
 * `apps/marketing/astro.config.mjs` — both import it from here rather than
 * repeating the literal, and both must spread Vite's `defaultClientConditions`
 * because `resolve.conditions` replaces them wholesale.
 */
export const ORT_EXTERN_WASM_CONDITION = 'onnxruntime-web-use-extern-wasm';

/**
 * Vite's worker build options, shared by both app configs.
 *
 * `format: 'es'` matches how the worker is constructed: the TTS worker is the
 * only `new Worker` in the repo and is instantiated with `{ type: 'module' }`,
 * so the emitted format and the instantiation stay in agreement rather than
 * relying on a classic-format bundle happening to execute inside a module
 * worker.
 *
 * Historical note, because a reader who tests the old reason will wrongly
 * conclude the pin is unnecessary: this was originally pinned because the
 * `iife` worker transform rewrote `new.target` into an `import.meta` stand-in,
 * which broke `@huggingface/transformers`' `Callable` base class — every
 * tokenizer and processor extends it, and it is built on
 * `Object.setPrototypeOf(closure, new.target.prototype)`. On rolldown 1.2.1
 * that rewrite no longer reproduces: built both ways, `new.target` survives
 * intact under `iife` too. `verify-bundle` still guards the built output
 * against it returning.
 *
 * Lives beside the ORT constants because this is the build-config seam both
 * `apps/web/vite.config.ts` and `apps/marketing/astro.config.mjs` already
 * import from; the format must never be spelled out per-app.
 */
export const WORKER_BUILD_OPTIONS = { format: 'es' } as const;

/**
 * Absolute path to the TTS worker's source, for use as an
 * `optimizeDeps.entries` scan entry in dev.
 *
 * Vite's dependency scanner never crosses a
 * `new Worker(new URL(…, import.meta.url))` edge: the plugin that understands
 * that pattern is registered only in the main pipeline, not in the scanner's
 * reduced plugin set. Dynamic imports are followed; worker entry points are
 * not. So kokoro-js — imported only inside the TTS worker — is invisible at
 * startup and gets discovered on the first worker fetch. Late discovery
 * re-chunks the whole prebundle, and any prebundle hash change forces a
 * full-page reload, which costs the user their first click on Listen / read
 * aloud.
 *
 * Naming the worker's source as a scan entry makes the scanner walk it at
 * startup. The path is named rather than the package, so nothing here can
 * drift against `packages/ui`'s dependency list and every future worker-only
 * dependency is covered by the same entry.
 */
export function resolveTtsWorkerSource(
  workerPath: string = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../packages/ui/src/components/accessibility/lib/tts.worker.ts'
  )
): string {
  if (!existsSync(workerPath)) {
    throw new Error(
      `TTS worker source not found at ${workerPath}. The dev dependency scanner ` +
        `cannot reach kokoro-js without it, so the first TTS click would trigger a ` +
        `full-page reload; update the path if the worker moved.`
    );
  }
  return workerPath;
}

/**
 * Resolved at config load so a moved or renamed worker fails the dev server
 * loudly instead of silently restoring the first-click reload. This assert is
 * the regression guard for that behaviour.
 */
export const TTS_WORKER_SCAN_ENTRY = resolveTtsWorkerSource();

/**
 * Absolute path to the prediction worker's source, for the same
 * `optimizeDeps.entries` reason as {@link resolveTtsWorkerSource}: the scanner
 * cannot cross its `new Worker(new URL(…))` edge either, so the inference
 * library it imports is discovered on the first composer focus and re-chunks
 * the prebundle mid-session.
 */
export function resolvePredictionWorkerSource(
  workerPath: string = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../apps/web/src/lib/prediction/prediction.worker.ts'
  )
): string {
  if (!existsSync(workerPath)) {
    throw new Error(
      `Prediction worker source not found at ${workerPath}. The dev dependency ` +
        `scanner cannot reach the inference library without it, so the first composer ` +
        `focus would trigger a full-page reload; update the path if the worker moved.`
    );
  }
  return workerPath;
}

/** Resolved at config load for the same reason as {@link TTS_WORKER_SCAN_ENTRY}. */
export const PREDICTION_WORKER_SCAN_ENTRY = resolvePredictionWorkerSource();

/**
 * Locate the installed `@huggingface/transformers` dist directory (reached
 * through kokoro-js's dependency), which holds the ORT runtime files bundled
 * with the exact transformers version loaded at runtime.
 */
export function ortDistributionDir(anchorPackageJson: string = UI_PACKAGE_JSON): string {
  const kokoroEntry = createRequire(anchorPackageJson).resolve('kokoro-js');
  const transformersEntry = createRequire(kokoroEntry).resolve('@huggingface/transformers');
  return path.dirname(transformersEntry);
}

/**
 * Collect the onnxruntime-web `.wasm`/`.mjs` runtime files from a dist
 * directory. Throws if none are present — a self-host with no runtime to serve
 * is a broken build, not a silent no-op.
 */
export function collectOrtAssets(distributionDir: string): OrtAsset[] {
  const files = readdirSync(distributionDir).filter((name) => /^ort-.*\.(wasm|mjs)$/u.test(name));
  if (files.length === 0) {
    throw new Error(
      `No onnxruntime-web WASM assets (ort-*.wasm/.mjs) found in ${distributionDir}. ` +
        `The TTS runtime cannot be self-hosted; check @huggingface/transformers is installed.`
    );
  }
  return files.map((fileName) => ({ fileName, absPath: path.resolve(distributionDir, fileName) }));
}

/**
 * Resolve onnxruntime-web's runtime files from the installed transformers, so
 * the self-hosted copies always match the version loaded at runtime.
 */
export function resolveOrtAssets(anchorPackageJson: string = UI_PACKAGE_JSON): OrtAsset[] {
  return collectOrtAssets(ortDistributionDir(anchorPackageJson));
}

export function contentTypeFor(fileName: string): string {
  return fileName.endsWith('.wasm') ? 'application/wasm' : 'text/javascript';
}

/**
 * Vite plugin that serves the ORT runtime files same-origin in dev and emits
 * them into the built dist. Shared verbatim by the web (Vite) and marketing
 * (Astro) builds.
 */
export function ortAssetsPlugin(): Plugin {
  const assets = resolveOrtAssets();
  return {
    name: 'ort-wasm-self-host',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        const match = assets.find((asset) => url === `${ORT_WASM_PATH}${asset.fileName}`);
        if (match === undefined) {
          next();
          return;
        }
        res.setHeader('Content-Type', contentTypeFor(match.fileName));
        createReadStream(match.absPath).pipe(res);
      });
    },
    generateBundle() {
      for (const asset of assets) {
        this.emitFile({
          type: 'asset',
          fileName: `${ORT_DIR}/${asset.fileName}`,
          source: readFileSync(asset.absPath),
        });
      }
    },
  };
}
