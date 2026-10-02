import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Destination, Mode, ref, secret } from '../packages/shared/src/env/env.config.js';
import { GROWTH_BEACON_PATH } from '../packages/shared/src/growth/beacon.js';
import { GROWTH_SCROLL_EVENTS } from '../packages/shared/src/growth/enums.js';

import { BUILD_TARGET, resolveOrtAssets, type OrtAsset } from './lib/bundling/seam.js';
import { PRE_PAINT_SCRIPTS } from './lib/bundling/pre-paint-scripts-plugin.js';
import { readCommandLine, type FlagRecord } from './lib/cli/command-line.js';
import {
  IOS_PROJECT_PATH,
  collectBuildTargetViolations,
  collectDeploymentTargetViolations,
  discoverTargetPinnedConfigs,
  writeDeploymentTarget,
} from './lib/bundling/build-targets.js';
import {
  COMMAND_LINE,
  PAGES_MAX_FILE_BYTES,
  appBundleOptions,
  bakesE2eBuildFlag,
  PAGES_MAX_FILE_COUNT,
  checkPagesLimits,
  collectBundleViolations,
  declaredE2eDeviceKeyMarkers,
  declaredE2ePredictorMarkers,
  declaredOpaqueProtocolLabels,
  declaredServiceWorkerFileName,
  declaredOrtCommonVersion,
  E2E_BUILD_FLAG_NAME,
  httpDeliveryStatement,
  noShippingBundlesNotice,
  REACT_DEVELOPMENT_BUILD_MARKER,
  requestedDistributionDirectories,
  shipsBundlesIn,
  requiredE2eBuildFlagValue,
  verifyBundle,
  type BundleFile,
} from './verify-bundle.js';

let bundleRoot: string;
let distributionDir: string;
let runtimeDir: string;

/** Stand-in for the installed onnxruntime-web runtime, so the fixtures stay
 * kilobytes instead of copying the real 21 MB wasm. */
async function fakeRuntime(): Promise<OrtAsset[]> {
  const names = ['ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs'];
  const assets: OrtAsset[] = [];
  for (const fileName of names) {
    const absPath = path.join(runtimeDir, fileName);
    await fs.writeFile(absPath, `runtime bytes for ${fileName}`);
    assets.push({ fileName, absPath });
  }
  return assets;
}

async function selfHost(assets: readonly OrtAsset[]): Promise<void> {
  await fs.mkdir(path.join(distributionDir, 'ort'), { recursive: true });
  for (const asset of assets) {
    await fs.copyFile(asset.absPath, path.join(distributionDir, 'ort', asset.fileName));
  }
}

async function writeDistributionFile(relativePath: string, content: string): Promise<void> {
  const absolute = path.join(distributionDir, relativePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content);
}

/**
 * A dist with no ORT version site at all is itself a violation, so every
 * fixture bundle starts with one compliant chunk. The version is derived, never
 * written down twice.
 */
const ORT_VERSION_CHUNK = 'assets/ort-env-baseline.js';

/** Same reason: a dist emitting no TTS worker chunk is itself a violation. */
const WORKER_CHUNK = 'assets/tts.worker-baseline.js';

/**
 * The backend environment schema as a minifier leaves it: entry names in
 * object-key position and nothing else. This is the shape that reached four
 * built origins while every guard on the tree stayed green.
 */
const LEAKED_ENV_SCHEMA =
  'const S=He({UPSTASH_REDIS_REST_TOKEN:de().min(1),' +
  'OPAQUE_KEK:de().min(32),IRON_SESSION_SECRET:de().min(32)});';

/**
 * The beacon as a chunk would carry it. Derived from the exported path, never
 * written down twice — the whole point of the constant is that the route, the
 * script and both guards read one definition.
 */
const BEACON_SEND_CHUNK = `fetch("${GROWTH_BEACON_PATH}",{method:"POST",keepalive:!0});`;

/** A growth event name as a chunk would carry it: a bare string literal that survives minification. */
const GROWTH_EVENT_CHUNK = `const e="${GROWTH_SCROLL_EVENTS[0]}";`;

/**
 * The E2E device-key store as a chunk carries it: the storage key survives
 * minification as a string literal, so it is what the artifact is searched for.
 * Derived from the store module, never written down twice.
 */
async function e2eDeviceKeyStoreChunk(): Promise<string> {
  const [marker] = await declaredE2eDeviceKeyMarkers();
  return `var STORAGE_KEY$1 = "${String(marker)}";`;
}

/**
 * The E2E prompt-predictor stub as a chunk carries it: its fixed answers survive
 * minification as string literals, so they are what the artifact is searched
 * for. Derived from the stub module, never written down twice.
 */
async function e2ePromptPredictorChunk(): Promise<string> {
  const [marker] = await declaredE2ePredictorMarkers();
  return `var COMPLETION$1 = "${String(marker)}";`;
}

/**
 * The abort message the production predictor raises — written word for word in
 * the stub too, so a check matching it would fail every bundle ever built.
 */
const PRODUCTION_PREDICTOR_CHUNK = 'const e = new Error("prediction aborted");';

/**
 * The value that marks an E2E build, read out of the registry the check reads
 * it from, so a check that went back to a literal of its own would stop
 * recognising these fixtures the moment the registry moved.
 */
const E2E_BUILD_FLAG_VALUE = requiredE2eBuildFlagValue();

/** The inlined `import.meta.env` object as an E2E build bakes it. */
const E2E_BUILD_ENV_CHUNK = `const env = {\n\t"${E2E_BUILD_FLAG_NAME}": "${E2E_BUILD_FLAG_VALUE}"\n};`;

/**
 * The same object as a non-E2E build would bake it if the flag ever gained a
 * value outside E2E mode: present, and not the value the resolver installs the
 * store on.
 */
const NON_E2E_BUILD_ENV_CHUNK = `const env = {\n\t"${E2E_BUILD_FLAG_NAME}": "false"\n};`;

/**
 * The same object as a minified build emits it: unquoted keys and template
 * literals for the values, which is what a real minified E2E dist carries.
 */
const MINIFIED_E2E_BUILD_ENV_CHUNK = `const $e={VITE_MODE:\`e2e\`,${E2E_BUILD_FLAG_NAME}:\`${E2E_BUILD_FLAG_VALUE}\`};`;

/**
 * React DOM's development client as a chunk carries it: its warning text. A real
 * E2E dist carries it in its marketing islands, so every E2E fixture does too.
 */
const DEVELOPMENT_REACT_CHUNK = `console.error("${REACT_DEVELOPMENT_BUILD_MARKER} %s.",k);`;

/**
 * The production store's own IndexedDB name — near enough to the E2E key to
 * prove the check is matching the store and not the word "device key".
 */
const PRODUCTION_DEVICE_KEY_CHUNK = 'const DB_NAME = "hushbox-device-key";';

beforeEach(async () => {
  bundleRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-bundle-'));
  // Named `dist`, because that is what marks a bundle as the origin's rather
  // than one of the OTA sibling dists the same app also builds. Those siblings
  // are written beside it, inside the root, which is why teardown removes
  // `bundleRoot` and never this child.
  distributionDir = path.join(bundleRoot, 'dist');
  await fs.mkdir(distributionDir, { recursive: true });
  runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-bundle-runtime-'));
  await writeDistributionFile(
    ORT_VERSION_CHUNK,
    `const env={versions:{common:\`${await declaredOrtCommonVersion()}\`}};`
  );
  await writeDistributionFile(WORKER_CHUNK, 'self.onmessage=()=>{};');
  // Same reason again: a dist with no `_headers` is itself a violation.
  await writeDistributionFile('_headers', '/*\n  X-Frame-Options: DENY\n');
});

afterEach(async () => {
  await fs.rm(bundleRoot, { recursive: true, force: true });
  await fs.rm(runtimeDir, { recursive: true, force: true });
});

describe('collectBundleViolations', () => {
  it('reports nothing for a bundle that self-hosts the runtime and ships no copies', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile('assets/tts.worker-abc.js', 'const p="/ort/";');

    expect(
      await collectBundleViolations({ distributionDir, shipsTts: true, ortAssets: assets })
    ).toEqual([]);
  });

  // The env-content check is orthogonal to the TTS expectation, and the bundle
  // that leaked is the one app that does ship TTS — so it has to run on this
  // branch too, not only on the TTS-free one below.
  it('reports the backend environment schema in a bundle that ships TTS', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile('assets/tts.worker-abc.js', 'const p="/ort/";');
    await writeDistributionFile('assets/index-abc.js', LEAKED_ENV_SCHEMA);

    const violations = await collectBundleViolations({
      distributionDir: distributionDir,
      shipsTts: true,
      ortAssets: assets,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('assets/index-abc.js');
  });

  // The growth beacon belongs to the marketing half of the merged bundle, and
  // apps/web is the app that merges the two — so this is the branch that
  // matters for it, not the TTS-free twin below.
  it('reports the growth beacon in a bundle that ships TTS', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile('assets/tts.worker-abc.js', 'const p="/ort/";');
    await writeDistributionFile('assets/index-abc.js', BEACON_SEND_CHUNK);

    const violations = await collectBundleViolations({
      distributionDir: distributionDir,
      shipsTts: true,
      ortAssets: assets,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('assets/index-abc.js');
  });

  // apps/web is both the app that ships TTS and the only one carrying a device
  // key at all, so this branch is where the store check actually earns its
  // place — its TTS-free twin, `reports a chunk carrying the E2E device-key
  // store`, only proves the check is wired to both branches.
  it('reports the E2E device-key store in a production bundle that ships TTS', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile('assets/tts.worker-abc.js', 'const p="/ort/";');
    await writeDistributionFile('assets/auth-abc.js', await e2eDeviceKeyStoreChunk());

    const violations = await collectBundleViolations({
      distributionDir,
      shipsTts: true,
      ortAssets: assets,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('assets/auth-abc.js');
  });

  it('accepts a production bundle carrying only the real device-key store', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile('assets/tts.worker-abc.js', 'const p="/ort/";');
    await writeDistributionFile('assets/auth-abc.js', PRODUCTION_DEVICE_KEY_CHUNK);

    expect(
      await collectBundleViolations({ distributionDir, shipsTts: true, ortAssets: assets })
    ).toEqual([]);
  });

  it('accepts the E2E device-key store in a bundle that bakes the E2E build flag', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile('assets/tts.worker-abc.js', 'const p="/ort/";');
    await writeDistributionFile('assets/auth-abc.js', await e2eDeviceKeyStoreChunk());
    await writeDistributionFile('assets/platform-abc.js', E2E_BUILD_ENV_CHUNK);
    await writeDistributionFile('_astro/client.abc.js', DEVELOPMENT_REACT_CHUNK);

    expect(
      await collectBundleViolations({ distributionDir, shipsTts: true, ortAssets: assets })
    ).toEqual([]);
  });

  // The flag is a gate that switches this assertion off, so what counts as
  // "on" has to be the resolver's own condition and nothing looser. A flag
  // valued anything else is a flag the resolver ignores, and a bundle carrying
  // one is a bundle the store has no business being in.
  it('reports the E2E device-key store in a bundle whose baked flag is not the resolver value', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile('assets/tts.worker-abc.js', 'const p="/ort/";');
    await writeDistributionFile('assets/auth-abc.js', await e2eDeviceKeyStoreChunk());
    await writeDistributionFile('assets/platform-abc.js', NON_E2E_BUILD_ENV_CHUNK);

    const violations = await collectBundleViolations({
      distributionDir,
      shipsTts: true,
      ortAssets: assets,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('assets/auth-abc.js');
  });

  it('accepts the E2E device-key store in a minified bundle baking the flag as a template literal', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile('assets/tts.worker-abc.js', 'const p="/ort/";');
    await writeDistributionFile('assets/auth-abc.js', await e2eDeviceKeyStoreChunk());
    await writeDistributionFile('assets/platform-abc.js', MINIFIED_E2E_BUILD_ENV_CHUNK);
    await writeDistributionFile('_astro/client.abc.js', DEVELOPMENT_REACT_CHUNK);

    expect(
      await collectBundleViolations({ distributionDir, shipsTts: true, ortAssets: assets })
    ).toEqual([]);
  });

  // A source map and a manifest ride in a dist without ever being run, so the
  // flag at the required value inside one is text about a build rather than a
  // flag a build baked.
  it('reports the E2E device-key store when the flag at the required value sits only in files nothing executes', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile('assets/tts.worker-abc.js', 'const p="/ort/";');
    await writeDistributionFile('assets/auth-abc.js', await e2eDeviceKeyStoreChunk());
    await writeDistributionFile('assets/platform-abc.js.map', E2E_BUILD_ENV_CHUNK);
    await writeDistributionFile('platform-manifest.json', E2E_BUILD_ENV_CHUNK);

    const violations = await collectBundleViolations({
      distributionDir,
      shipsTts: true,
      ortAssets: assets,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('assets/auth-abc.js');
  });

  // apps/web ships TTS and is the only app carrying a predictor at all, so this
  // branch is where the stub check actually earns its place; its TTS-free twin
  // only proves the check is wired to both branches.
  it('reports the E2E prompt-predictor stub in a production bundle that ships TTS', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile('assets/tts.worker-abc.js', 'const p="/ort/";');
    await writeDistributionFile('assets/composer-abc.js', await e2ePromptPredictorChunk());

    const violations = await collectBundleViolations({
      distributionDir,
      shipsTts: true,
      ortAssets: assets,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('assets/composer-abc.js');
  });

  it('accepts a production bundle carrying only the real predictor', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile('assets/tts.worker-abc.js', 'const p="/ort/";');
    await writeDistributionFile('assets/composer-abc.js', PRODUCTION_PREDICTOR_CHUNK);

    expect(
      await collectBundleViolations({ distributionDir, shipsTts: true, ortAssets: assets })
    ).toEqual([]);
  });

  it('accepts the E2E prompt-predictor stub in a bundle that bakes the E2E build flag', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile('assets/tts.worker-abc.js', 'const p="/ort/";');
    await writeDistributionFile('assets/composer-abc.js', await e2ePromptPredictorChunk());
    await writeDistributionFile('assets/platform-abc.js', E2E_BUILD_ENV_CHUNK);
    await writeDistributionFile('_astro/client.abc.js', DEVELOPMENT_REACT_CHUNK);

    expect(
      await collectBundleViolations({ distributionDir, shipsTts: true, ortAssets: assets })
    ).toEqual([]);
  });

  it('reports a self-hosted runtime file the build never emitted', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await fs.rm(path.join(distributionDir, 'ort/ort-wasm-simd-threaded.jsep.wasm'));

    const violations = await collectBundleViolations({
      distributionDir,
      shipsTts: true,
      ortAssets: assets,
    });

    expect(violations).toEqual([
      expect.stringContaining('ort/ort-wasm-simd-threaded.jsep.wasm') as unknown as string,
    ]);
    expect(violations[0]).toMatch(/missing/i);
  });

  it('reports a self-hosted runtime file whose bytes differ from the installed runtime', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile(
      'ort/ort-wasm-simd-threaded.jsep.mjs',
      'stale bytes from another version'
    );

    const violations = await collectBundleViolations({
      distributionDir,
      shipsTts: true,
      ortAssets: assets,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/ort-wasm-simd-threaded\.jsep\.mjs/);
    expect(violations[0]).toMatch(/sha256|match/i);
  });

  it('reports every ORT runtime copy emitted outside the self-hosted directory', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile('assets/ort-wasm-simd-threaded.jsep-B0T3yYHD.wasm', 'copy');
    await writeDistributionFile('_astro/ort-wasm-simd-threaded.jsep-B0T3yYHD.mjs', 'copy');

    const violations = await collectBundleViolations({
      distributionDir,
      shipsTts: true,
      ortAssets: assets,
    });

    expect(violations).toHaveLength(2);
    expect(violations.join('\n')).toContain('assets/ort-wasm-simd-threaded.jsep-B0T3yYHD.wasm');
    expect(violations.join('\n')).toContain('_astro/ort-wasm-simd-threaded.jsep-B0T3yYHD.mjs');
  });

  it('reports a built script that still references the bundler-emitted /assets/ort- asset', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile('assets/tts.worker-abc.js', 'new URL("/assets/ort-wasm.wasm",x)');

    const violations = await collectBundleViolations({
      distributionDir,
      shipsTts: true,
      ortAssets: assets,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('assets/tts.worker-abc.js');
  });

  it('reports a built script that still references the bundler-emitted /_astro/ort- asset', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile('_astro/tts.worker-abc.js', 'new URL("/_astro/ort-wasm.wasm",x)');

    const violations = await collectBundleViolations({
      distributionDir,
      shipsTts: true,
      ortAssets: assets,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('_astro/tts.worker-abc.js');
  });

  it('ignores source maps, which legitimately name the bundler-emitted asset', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile(
      'assets/tts.worker-abc.js.map',
      '{"sources":["/assets/ort-wasm.wasm"]}'
    );

    expect(
      await collectBundleViolations({ distributionDir, shipsTts: true, ortAssets: assets })
    ).toEqual([]);
  });

  it('reports a file over the Cloudflare Pages per-file size cap', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    const oversized = path.join(distributionDir, 'assets/oversized.bin');
    await fs.mkdir(path.dirname(oversized), { recursive: true });
    // Sparse: the guard reads sizes from stat, never the bytes.
    const handle = await fs.open(oversized, 'w');
    await handle.truncate(PAGES_MAX_FILE_BYTES + 1);
    await handle.close();

    const violations = await collectBundleViolations({
      distributionDir,
      shipsTts: true,
      ortAssets: assets,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('assets/oversized.bin');
    expect(violations[0]).toContain(String(PAGES_MAX_FILE_BYTES));
  });

  it('accepts a chunk whose ORT version reaches `versions.common` through a local', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    const pinned = await declaredOrtCommonVersion();
    await writeDistributionFile(
      'assets/tts.worker-abc.js',
      `const version$1 = "${pinned}";\nconst env = {\n\tversions: { common: version$1 }\n};`
    );

    expect(
      await collectBundleViolations({ distributionDir, shipsTts: true, ortAssets: assets })
    ).toEqual([]);
  });

  it('reports a chunk carrying an onnxruntime-common version other than the pin', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile(
      'assets/tts.worker-abc.js',
      'const env={versions:{common:"0.0.0-hoisted"}};'
    );

    const violations = await collectBundleViolations({
      distributionDir,
      shipsTts: true,
      ortAssets: assets,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('assets/tts.worker-abc.js');
    expect(violations[0]).toContain('0.0.0-hoisted');
    expect(violations[0]).toContain(await declaredOrtCommonVersion());
  });

  it('reports a chunk carrying two different onnxruntime-common versions', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile(
      'assets/tts.worker-abc.js',
      `const inlined=\`${await declaredOrtCommonVersion()}\`;` +
        'const runtime={versions:{common:inlined}};' +
        'const external={versions:{common:`1.26.0`}};'
    );

    const violations = await collectBundleViolations({
      distributionDir,
      shipsTts: true,
      ortAssets: assets,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('1.26.0');
  });

  it('reports a bundle in which no ORT version site was found at all', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await fs.rm(path.join(distributionDir, ORT_VERSION_CHUNK));

    const violations = await collectBundleViolations({
      distributionDir,
      shipsTts: true,
      ortAssets: assets,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/no onnxruntime version/i);
  });

  it('reports a version bound to a local it cannot resolve', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile('assets/tts.worker-abc.js', 'const env={versions:{common:unset}};');

    const violations = await collectBundleViolations({
      distributionDir,
      shipsTts: true,
      ortAssets: assets,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('unset');
    expect(violations[0]).toContain('assets/tts.worker-abc.js');
  });

  it('accepts a worker chunk that reads the bundler import.meta stand-in normally', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile(
      'assets/tts.worker-abc.js',
      'var _vite_importMeta = { url: self.location.href };\n' +
        'const _import_meta_url = Object(_vite_importMeta).url;'
    );

    expect(
      await collectBundleViolations({ distributionDir, shipsTts: true, ortAssets: assets })
    ).toEqual([]);
  });

  it('reports a worker chunk whose new.target was rewritten to the import.meta stand-in', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile(
      'assets/tts.worker-abc.js',
      'var _vite_importMeta = { url: self.location.href };\n' +
        'return Object.setPrototypeOf(closure, _vite_importMeta.prototype);'
    );

    const violations = await collectBundleViolations({
      distributionDir,
      shipsTts: true,
      ortAssets: assets,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('assets/tts.worker-abc.js');
    expect(violations[0]).toContain('_vite_importMeta');
    expect(violations[0]).toContain('new.target');
  });

  it('reports a minified worker chunk whose import.meta stand-in was renamed', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile(
      'assets/tts.worker-abc.js',
      'var df={url:self.location.href},ff={};' +
        'class y{constructor(){return Object.setPrototypeOf(e,df.prototype)}}'
    );

    const violations = await collectBundleViolations({
      distributionDir,
      shipsTts: true,
      ortAssets: assets,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('assets/tts.worker-abc.js');
    expect(violations[0]).toContain('df');
  });

  it('reports a bundle that emitted no TTS worker chunk at all', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await fs.rm(path.join(distributionDir, WORKER_CHUNK));

    const violations = await collectBundleViolations({
      distributionDir,
      shipsTts: true,
      ortAssets: assets,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/tts\.worker/);
    expect(violations[0]).toMatch(/vacuously/i);
  });

  it('reports a missing _headers file', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile('assets/tts.worker-abc.js', 'const p="/ort/";');
    await fs.rm(path.join(distributionDir, '_headers'));

    const violations = await collectBundleViolations({
      distributionDir,
      shipsTts: true,
      ortAssets: assets,
    });

    expect(violations).toEqual([expect.stringContaining('_headers')]);
  });

  it('does not ask an OTA sibling dist for a _headers file', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile('assets/tts.worker-abc.js', 'const p="/ort/";');
    await fs.rm(path.join(distributionDir, '_headers'));
    const otaDir = path.join(path.dirname(distributionDir), 'dist-ios');
    await fs.cp(distributionDir, otaDir, { recursive: true });

    const violations = await collectBundleViolations({
      distributionDir: otaDir,
      shipsTts: true,
      ortAssets: assets,
    });

    expect(violations).toEqual([]);
  });

  it('asks for no _headers file when the caller states the bundle is not served over HTTP', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile('assets/tts.worker-abc.js', 'const p="/ort/";');
    await fs.rm(path.join(distributionDir, '_headers'));

    const violations = await collectBundleViolations({
      distributionDir,
      shipsTts: true,
      ortAssets: assets,
      servedOverHttp: false,
    });

    expect(violations).toEqual([]);
  });

  // The statement exempts one requirement, not the verification: a bundle that
  // answers no request still ships the code every other check reads.
  it('reports a bundle stating it is not served over HTTP for a defect outside the header file', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile('assets/tts.worker-abc.js', 'const p="/ort/";');
    await writeDistributionFile('assets/index-abc.js', LEAKED_ENV_SCHEMA);
    await fs.rm(path.join(distributionDir, '_headers'));

    const violations = await collectBundleViolations({
      distributionDir,
      shipsTts: true,
      ortAssets: assets,
      servedOverHttp: false,
    });

    expect(violations).toEqual([expect.stringContaining('UPSTASH_REDIS_REST_TOKEN')]);
  });

  it('asks an OTA-named dist for a _headers file when the caller states it is served over HTTP', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile('assets/tts.worker-abc.js', 'const p="/ort/";');
    await fs.rm(path.join(distributionDir, '_headers'));
    const otaDir = path.join(path.dirname(distributionDir), 'dist-ios');
    await fs.cp(distributionDir, otaDir, { recursive: true });

    const violations = await collectBundleViolations({
      distributionDir: otaDir,
      shipsTts: true,
      ortAssets: assets,
      servedOverHttp: true,
    });

    expect(violations).toEqual([expect.stringContaining('_headers')]);
  });

  // The mobile update bundles are a second place the same service worker and
  // the same chunks ship from, verified through the build that writes them
  // rather than through this file's default dist. The check is per-dist, so it
  // reaches them wherever they are verified.
  it('reports the growth beacon in an OTA sibling dist', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile('assets/tts.worker-abc.js', 'const p="/ort/";');
    await fs.rm(path.join(distributionDir, '_headers'));
    const otaDir = path.join(path.dirname(distributionDir), 'dist-android');
    await fs.cp(distributionDir, otaDir, { recursive: true });
    await fs.writeFile(
      path.join(otaDir, await declaredServiceWorkerFileName()),
      GROWTH_EVENT_CHUNK
    );

    const violations = await collectBundleViolations({
      distributionDir: otaDir,
      shipsTts: true,
      ortAssets: assets,
    });

    expect(violations).toEqual([expect.stringContaining(await declaredServiceWorkerFileName())]);
  });

  it('resolves the runtime from the installed package when no assets are supplied', async () => {
    const violations = await collectBundleViolations({ distributionDir, shipsTts: true });

    const installed = resolveOrtAssets();
    expect(violations).toHaveLength(installed.length);
    for (const asset of installed) {
      expect(violations.join('\n')).toContain(`ort/${asset.fileName}`);
    }
  });
});

/** Every pre-paint script tag a built SPA shell has to carry. */
function prePaintScriptTags(): string {
  return [...PRE_PAINT_SCRIPTS.values()].map((script) => `<script>${script}</script>`).join('');
}

describe('collectBundleViolations for a dist that must not ship TTS', () => {
  let appDir: string;
  let ttsFreeDistribution: string;

  beforeEach(async () => {
    appDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-bundle-app-'));
    ttsFreeDistribution = path.join(appDir, 'dist');
    await fs.mkdir(ttsFreeDistribution, { recursive: true });
    await fs.writeFile(path.join(ttsFreeDistribution, '_headers'), '/*\n  X-Frame-Options: DENY\n');
  });

  afterEach(async () => {
    await fs.rm(appDir, { recursive: true, force: true });
  });

  async function writeAppFile(relativePath: string, content: string): Promise<void> {
    const absolute = path.join(appDir, relativePath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content);
  }

  /** Bytes rather than a string, so a fixture can be something other than text. */
  async function writeBinaryDistributionFile(relativePath: string, content: Buffer): Promise<void> {
    const absolute = path.join(ttsFreeDistribution, relativePath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content);
  }

  it('reports the worker chunk and the ORT runtime file it must not contain', async () => {
    await writeAppFile('dist/assets/tts.worker-abc.js', 'self.onmessage=()=>{};');
    await writeAppFile('dist/assets/ort-wasm-simd-threaded.jsep-xyz.wasm', 'runtime bytes');

    const violations = await collectBundleViolations({
      distributionDir: ttsFreeDistribution,
      shipsTts: false,
    });

    expect(violations).toHaveLength(2);
    expect(violations.join('\n')).toContain('assets/tts.worker-abc.js');
    expect(violations.join('\n')).toContain('assets/ort-wasm-simd-threaded.jsep-xyz.wasm');
  });

  it('accepts a dist carrying neither a worker chunk nor an ORT runtime file', async () => {
    await writeAppFile('dist/assets/index-abc.js', 'console.info("app");');

    const violations = await collectBundleViolations({
      distributionDir: ttsFreeDistribution,
      shipsTts: false,
    });

    expect(violations).toEqual([]);
  });

  it('still reports a file over the Cloudflare Pages per-file size cap', async () => {
    const oversized = path.join(ttsFreeDistribution, 'oversized.bin');
    const handle = await fs.open(oversized, 'w');
    await handle.truncate(PAGES_MAX_FILE_BYTES + 1);
    await handle.close();

    const violations = await collectBundleViolations({
      distributionDir: ttsFreeDistribution,
      shipsTts: false,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('oversized.bin');
  });

  it('reports a dist whose _headers file is missing', async () => {
    await fs.rm(path.join(ttsFreeDistribution, '_headers'));
    await writeAppFile('dist/assets/index-abc.js', 'console.info("app");');

    const violations = await collectBundleViolations({
      distributionDir: ttsFreeDistribution,
      shipsTts: false,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('_headers');
  });

  it('reports a chunk stating the backend environment schema', async () => {
    await writeAppFile('dist/assets/index-abc.js', LEAKED_ENV_SCHEMA);

    const violations = await collectBundleViolations({
      distributionDir: ttsFreeDistribution,
      shipsTts: false,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('assets/index-abc.js');
    expect(violations[0]).toContain('OPAQUE_KEK');
  });

  it('reports a chunk carrying the E2E device-key store', async () => {
    await writeAppFile('dist/assets/index-abc.js', await e2eDeviceKeyStoreChunk());

    const violations = await collectBundleViolations({
      distributionDir: ttsFreeDistribution,
      shipsTts: false,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('assets/index-abc.js');
  });

  it('reports a chunk carrying the E2E prompt-predictor stub', async () => {
    await writeAppFile('dist/assets/index-abc.js', await e2ePromptPredictorChunk());

    const violations = await collectBundleViolations({
      distributionDir: ttsFreeDistribution,
      shipsTts: false,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('assets/index-abc.js');
  });

  it('reports a chunk sending to the growth beacon', async () => {
    await writeAppFile('dist/assets/index-abc.js', BEACON_SEND_CHUNK);

    const violations = await collectBundleViolations({
      distributionDir: ttsFreeDistribution,
      shipsTts: false,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('assets/index-abc.js');
    expect(violations[0]).toContain(GROWTH_BEACON_PATH);
  });

  it('reports a chunk carrying a growth event name', async () => {
    await writeAppFile('dist/assets/index-abc.js', GROWTH_EVENT_CHUNK);

    const violations = await collectBundleViolations({
      distributionDir: ttsFreeDistribution,
      shipsTts: false,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('assets/index-abc.js');
    expect(violations[0]).toContain(GROWTH_SCROLL_EVENTS[0]);
  });

  // The service worker is emitted unhashed at the dist root rather than into
  // the chunk directory, so a reach that stopped at the shell and the chunks
  // would never open it — while it is served from the app origin, ships in the
  // Pages deploy and in every mobile update bundle, and runs with the app's
  // session. It is also the one app artifact built with module side effects
  // declared away, so it drops and keeps different things than the app bundle.
  it('reports the service worker carrying a growth event name', async () => {
    await writeAppFile(`dist/${await declaredServiceWorkerFileName()}`, GROWTH_EVENT_CHUNK);

    const violations = await collectBundleViolations({
      distributionDir: ttsFreeDistribution,
      shipsTts: false,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(await declaredServiceWorkerFileName());
    expect(violations[0]).toContain(GROWTH_SCROLL_EVENTS[0]);
  });

  it('reports the service worker sending to the growth beacon', async () => {
    await writeAppFile(`dist/${await declaredServiceWorkerFileName()}`, BEACON_SEND_CHUNK);

    const violations = await collectBundleViolations({
      distributionDir: ttsFreeDistribution,
      shipsTts: false,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(GROWTH_BEACON_PATH);
  });

  // The marketing site is merged into this same dist and its pages are where
  // the beacon is supposed to be. A check that read them would fail every
  // bundle built after the script ships, which is why the reach is the SPA's
  // own shell and chunk directory rather than every text file in the tree.
  it('leaves the beacon on a merged marketing page alone', async () => {
    await writeAppFile('dist/welcome/index.html', `<script>${BEACON_SEND_CHUNK}</script>`);

    const violations = await collectBundleViolations({
      distributionDir: ttsFreeDistribution,
      shipsTts: false,
    });

    expect(violations).toEqual([]);
  });

  // Astro emits pages, and the sandbox origin's frames carry their bootstrap
  // inline, so a page is as much a place for this to land as a chunk is.
  it('reports backend environment content inlined into a page', async () => {
    // The shell carries the pre-paint scripts a real one carries, so the only
    // violation left for this fixture to produce is the env leak it is about.
    await writeAppFile(
      'dist/index.html',
      `${prePaintScriptTags()}<script>${LEAKED_ENV_SCHEMA}</script>`
    );

    const violations = await collectBundleViolations({
      distributionDir: ttsFreeDistribution,
      shipsTts: false,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('index.html');
  });

  /**
   * A public origin serves far more text than it serves code — response
   * headers, manifests, feeds, indexes — and every byte of it is as readable as
   * a chunk. The reach was once an extension list, and the one match in the
   * whole shipped tree sat in `_headers`, which that list did not name.
   */
  it('reports backend environment content in served text that is not code', async () => {
    await writeAppFile(
      'dist/_headers',
      `/*\n  X-Frame-Options: DENY\n  X-Env: ${LEAKED_ENV_SCHEMA}\n`
    );

    const violations = await collectBundleViolations({
      distributionDir: ttsFreeDistribution,
      shipsTts: false,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('_headers');
    expect(violations[0]).toContain('OPAQUE_KEK');
  });

  /**
   * Text-ness is read off the bytes, so the reach stops where a file stops
   * being text rather than where a name stops being recognised. A NUL byte says
   * so first: an image or a wasm payload spelling these characters is matched by
   * nothing, and NUL is legal UTF-8, so the decode below would let one through.
   */
  it('does not read an asset carrying a NUL byte as text', async () => {
    await writeAppFile('dist/assets/index-abc.js', 'console.info("app");');
    await writeBinaryDistributionFile(
      'assets/payload.bin',
      Buffer.concat([Buffer.from([0]), Buffer.from(LEAKED_ENV_SCHEMA)])
    );

    const violations = await collectBundleViolations({
      distributionDir: ttsFreeDistribution,
      shipsTts: false,
    });

    expect(violations).toEqual([]);
  });

  /**
   * The other half of the same question, and the half the NUL test cannot
   * answer: a payload that carries no NUL near its start is still not text when
   * its bytes decode as nothing.
   */
  it('does not read an asset whose bytes are not valid UTF-8 as text', async () => {
    await writeAppFile('dist/assets/index-abc.js', 'console.info("app");');
    await writeBinaryDistributionFile(
      'assets/payload.bin',
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(LEAKED_ENV_SCHEMA)])
    );

    const violations = await collectBundleViolations({
      distributionDir: ttsFreeDistribution,
      shipsTts: false,
    });

    expect(violations).toEqual([]);
  });

  it('does not walk the checked-in native copy of the built app beside dist', async () => {
    await writeAppFile(
      'android/app/src/main/assets/public/assets/tts.worker-abc.js',
      'self.onmessage=()=>{};'
    );
    await writeAppFile(
      'android/app/src/main/assets/public/ort/ort-wasm-simd-threaded.jsep.wasm',
      'runtime bytes'
    );

    const violations = await collectBundleViolations({
      distributionDir: ttsFreeDistribution,
      shipsTts: false,
    });

    expect(violations).toEqual([]);
  });
});

describe('appBundleOptions', () => {
  it('expects TTS in the merged web bundle', () => {
    expect(appBundleOptions('/repo', 'apps/web')).toEqual({
      distributionDir: path.join('/repo', 'apps/web/dist'),
      shipsTts: true,
    });
  });

  it('expects no TTS in the admin bundle', () => {
    expect(appBundleOptions('/repo', 'apps/admin')).toEqual({
      distributionDir: path.join('/repo', 'apps/admin/dist'),
      shipsTts: false,
    });
  });

  it('declares no TTS for crawler-view', () => {
    expect(appBundleOptions('/repo', 'apps/crawler-view').shipsTts).toBe(false);
  });

  it('expects no TTS in the sandbox origin bundle', () => {
    expect(appBundleOptions('/repo', 'apps/sandbox')).toEqual({
      distributionDir: path.join('/repo', 'apps/sandbox/dist'),
      shipsTts: false,
    });
  });

  it('keeps the app declaration when a sibling dist directory is named', () => {
    expect(appBundleOptions('/repo', 'apps/web', 'dist-ios')).toEqual({
      distributionDir: path.join('/repo', 'apps/web/dist-ios'),
      shipsTts: true,
    });
  });

  // The mode a CI run builds under and the mode its local sibling builds under
  // name one stack and therefore one generated file, so the file is named for
  // the stack rather than for the mode that asked for it.
  it('names the generated env file of the stack the build was invoked for', () => {
    expect(appBundleOptions('/repo', 'apps/web', undefined, Mode.CiE2E).stackEnvFile).toBe(
      path.join('/repo', '.env.e2e')
    );
  });

  it('names no env file for a caller that can name no stack', () => {
    expect(appBundleOptions('/repo', 'apps/web').stackEnvFile).toBeUndefined();
  });

  it('throws for an app that never declared a TTS expectation', () => {
    expect(() => appBundleOptions('/repo', 'apps/marketing')).toThrow(/declared TTS expectation/);
  });
});

describe('requestedDistributionDirectories', () => {
  it('verifies the primary dist when no directory is named', () => {
    expect(requestedDistributionDirectories([])).toEqual(['dist']);
  });

  it('verifies every directory named on the command line', () => {
    expect(requestedDistributionDirectories(['dist-ios', 'dist-android'])).toEqual([
      'dist-ios',
      'dist-android',
    ]);
  });
});

describe('httpDeliveryStatement', () => {
  /** Through the real grammar, so the flag has to be declared to be readable. */
  function flagsOf(argv: readonly string[]): FlagRecord {
    const parsed = readCommandLine(COMMAND_LINE, argv, () => undefined);
    if (parsed === null) throw new Error('the command line asked for usage');
    return parsed.flags;
  }

  it('leaves the delivery unstated when the command line says nothing about it', () => {
    expect(httpDeliveryStatement(flagsOf([]))).toEqual({});
  });

  it('states the bundle is not served over HTTP when the command line says so', () => {
    expect(httpDeliveryStatement(flagsOf(['--not-served-over-http']))).toEqual({
      servedOverHttp: false,
    });
  });
});

describe('checkPagesLimits', () => {
  const file = (relativePath: string, bytes: number): BundleFile => ({
    relativePath,
    absolutePath: `/dist/${relativePath}`,
    bytes,
  });

  it('reports nothing when the bundle is within both caps', () => {
    expect(checkPagesLimits([file('a.js', 10)])).toEqual([]);
  });

  it('reports the total when the bundle exceeds the Pages file-count cap', () => {
    const files = Array.from({ length: PAGES_MAX_FILE_COUNT + 1 }, (_, index) =>
      file(`chunk-${String(index)}.js`, 1)
    );

    const violations = checkPagesLimits(files);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(String(PAGES_MAX_FILE_COUNT + 1));
    expect(violations[0]).toContain(String(PAGES_MAX_FILE_COUNT));
  });
});

describe('verifyBundle', () => {
  it('resolves for a compliant bundle', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);

    await expect(
      verifyBundle({ distributionDir, shipsTts: true, ortAssets: assets })
    ).resolves.toBeUndefined();
  });

  it('throws naming every violation it found', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile('assets/ort-wasm-simd-threaded.jsep-B0T3yYHD.wasm', 'copy');
    await writeDistributionFile('assets/tts.worker-abc.js', 'new URL("/assets/ort-wasm.wasm",x)');

    await expect(
      verifyBundle({ distributionDir, shipsTts: true, ortAssets: assets })
    ).rejects.toThrow(/ort-wasm-simd-threaded\.jsep-B0T3yYHD\.wasm[\S\s]*tts\.worker-abc\.js/);
  });

  it('names the verified dist in its failure message', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile('assets/ort-wasm-simd-threaded.jsep-B0T3yYHD.wasm', 'copy');

    await expect(
      verifyBundle({ distributionDir, shipsTts: true, ortAssets: assets })
    ).rejects.toThrow(`Bundle verification failed (${distributionDir}):`);
  });

  it('hashes the real self-hosted runtime bytes rather than trusting the file name', async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    const wasm = path.join(distributionDir, 'ort/ort-wasm-simd-threaded.jsep.wasm');
    const digest = createHash('sha256')
      .update(await fs.readFile(wasm))
      .digest('hex');
    await fs.writeFile(wasm, 'tampered');

    await expect(
      verifyBundle({ distributionDir, shipsTts: true, ortAssets: assets })
    ).rejects.toThrow(new RegExp(digest.slice(0, 12)));
  });
});

describe('declaredOrtCommonVersion', () => {
  async function writeWorkspaceFile(contents: string): Promise<string> {
    const workspacePath = path.join(runtimeDir, 'pnpm-workspace.yaml');
    await fs.writeFile(workspacePath, contents);
    return workspacePath;
  }

  function extensionBlock(declared: string): string {
    return [
      'packageExtensions:',
      "  '@huggingface/transformers@3.8.1':",
      '    dependencies:',
      `      onnxruntime-common: ${declared}`,
      '',
    ].join('\n');
  }

  it('returns the version the transformers package extension declares', async () => {
    const workspacePath = await writeWorkspaceFile(extensionBlock('9.8.7-dev.20250101-abcdef0'));

    expect(await declaredOrtCommonVersion(workspacePath)).toBe('9.8.7-dev.20250101-abcdef0');
  });

  it("reads the repository's own workspace file when given no path", async () => {
    expect(await declaredOrtCommonVersion()).toMatch(/^\d+\.\d+\.\d+/u);
  });

  it('rejects a workspace file declaring no onnxruntime-common extension', async () => {
    const workspacePath = await writeWorkspaceFile(
      [
        'packageExtensions:',
        "  '@huggingface/transformers@3.8.1':",
        '    dependencies: {}',
        '',
      ].join('\n')
    );

    await expect(declaredOrtCommonVersion(workspacePath)).rejects.toThrow(/onnxruntime-common/u);
  });

  it('rejects a range where an exact onnxruntime-common version is required', async () => {
    const workspacePath = await writeWorkspaceFile(extensionBlock('^1.22.0'));

    await expect(declaredOrtCommonVersion(workspacePath)).rejects.toThrow(/\^1\.22\.0/u);
  });
});

describe('declaredServiceWorkerFileName', () => {
  async function writePluginModule(contents: string): Promise<string> {
    const modulePath = path.join(runtimeDir, 'service-worker-build-plugin.ts');
    await fs.writeFile(modulePath, contents);
    return modulePath;
  }

  it('returns the file name the build plugin emits the worker under', async () => {
    const modulePath = await writePluginModule("lib: { fileName: () => 'worker.js' },\n");

    expect(await declaredServiceWorkerFileName(modulePath)).toBe('worker.js');
  });

  it('refuses a plugin module declaring no emitted file name', async () => {
    const modulePath = await writePluginModule('lib: { formats: ["iife"] },\n');

    await expect(declaredServiceWorkerFileName(modulePath)).rejects.toThrow(/file name/u);
  });

  it('reads the real plugin, so a rename there reaches this check', async () => {
    expect(await declaredServiceWorkerFileName()).toMatch(/\.js$/u);
  });
});

describe('declaredE2eDeviceKeyMarkers', () => {
  async function writeStoreModule(contents: string): Promise<string> {
    const modulePath = path.join(runtimeDir, 'device-key-store.e2e.ts');
    await fs.writeFile(modulePath, contents);
    return modulePath;
  }

  it('returns the storage key the E2E store module declares', async () => {
    const modulePath = await writeStoreModule("const STORAGE_KEY = 'a_test_only_key';\n");

    expect(await declaredE2eDeviceKeyMarkers(modulePath)).toEqual(['a_test_only_key']);
  });

  // A reader that stops at the first declaration leaves every later one
  // invisible to the assertion built on it, which is a guard reporting green
  // over the thing it exists to catch.
  it('returns every storage key the module declares, not the first', async () => {
    const modulePath = await writeStoreModule(
      [
        "const STORAGE_KEY = 'first_test_only_key';",
        "const STORAGE_KEY_LEGACY = 'second_test_only_key';",
        '',
      ].join('\n')
    );

    expect(await declaredE2eDeviceKeyMarkers(modulePath)).toEqual([
      'first_test_only_key',
      'second_test_only_key',
    ]);
  });

  it("reads the repository's own E2E store module when given no path", async () => {
    expect(await declaredE2eDeviceKeyMarkers()).toEqual([expect.stringMatching(/\S/u)]);
  });

  it('rejects a module declaring no storage key', async () => {
    const modulePath = await writeStoreModule('export const nothing = 1;\n');

    await expect(declaredE2eDeviceKeyMarkers(modulePath)).rejects.toThrow(/storage key/u);
  });
});

describe('declaredE2ePredictorMarkers', () => {
  async function writeStubModule(contents: string): Promise<string> {
    const modulePath = path.join(runtimeDir, 'prompt-predictor.e2e.ts');
    await fs.writeFile(modulePath, contents);
    return modulePath;
  }

  it('returns the completion the stub module declares', async () => {
    const modulePath = await writeStubModule("const COMPLETION = ' a test-only completion.';\n");

    expect(await declaredE2ePredictorMarkers(modulePath)).toEqual([' a test-only completion.']);
  });

  // A reader that stops at the completion leaves every alternative invisible to
  // the assertion built on it, so a bundle carrying only the alternatives
  // reports green over exactly what the check exists to catch.
  it('returns the alternatives beside the completion', async () => {
    const modulePath = await writeStubModule(
      [
        "const COMPLETION = ' a test-only completion.';",
        "const ALTERNATIVES: readonly string[] = [' first rival.', ' second rival.'];",
        '',
      ].join('\n')
    );

    expect(await declaredE2ePredictorMarkers(modulePath)).toEqual([
      ' a test-only completion.',
      ' first rival.',
      ' second rival.',
    ]);
  });

  it("reads the repository's own stub module when given no path", async () => {
    expect(await declaredE2ePredictorMarkers()).toEqual(
      expect.arrayContaining([expect.stringMatching(/\S/u)])
    );
  });

  it('rejects a module declaring no answers', async () => {
    const modulePath = await writeStubModule('export const nothing = 1;\n');

    await expect(declaredE2ePredictorMarkers(modulePath)).rejects.toThrow(/answers/u);
  });
});

describe('requiredE2eBuildFlagValue', () => {
  // The value is read out of the registry rather than written down beside it,
  // so a registry entry carrying something else has to come back out. A copy
  // restated here would return the copy and this would fail.
  it('reads the E2E-mode value out of the registry entry it is given', () => {
    expect(
      requiredE2eBuildFlagValue({ to: [Destination.Frontend], [Mode.E2E]: 'not-the-real-value' })
    ).toBe('not-the-real-value');
  });

  // The registry expresses a mode's value as a reference to another mode's
  // whenever the two share one, and the reference object is not a value any
  // build bakes.
  it('follows a reference to another mode instead of returning the reference', () => {
    expect(
      requiredE2eBuildFlagValue({
        to: [Destination.Frontend],
        [Mode.Development]: 'from-development',
        [Mode.E2E]: ref(Mode.Development),
      })
    ).toBe('from-development');
  });

  it("reads the repository's own registry entry when given none", () => {
    expect(requiredE2eBuildFlagValue()).toEqual(expect.stringMatching(/\S/u));
  });

  it('rejects an entry with no value in E2E mode', () => {
    expect(() => requiredE2eBuildFlagValue({ to: [Destination.Frontend] })).toThrow(/e2e/iu);
  });

  // A credential is a value no build can bake into an artifact, so it separates
  // no bundle from any other.
  it('rejects an entry whose E2E value is a secret rather than a literal', () => {
    expect(() =>
      requiredE2eBuildFlagValue({ to: [Destination.Frontend], [Mode.E2E]: secret('NOT_A_LITERAL') })
    ).toThrow(/literal/u);
  });
});

describe('bakesE2eBuildFlag', () => {
  interface FlagShape {
    readonly name: string;
    readonly source: string;
  }

  /** The chunk text a bundler emits around an inlined env entry. */
  function envChunkBaking(entry: string): string {
    return `const $e={${entry}};`;
  }

  /** The string-literal forms a bundler can emit a value under. */
  const STRING_QUOTES = [
    { quote: '"', shape: 'double quotes' },
    { quote: "'", shape: 'single quotes' },
    { quote: '`', shape: 'backticks' },
  ] as const;

  /**
   * A value opened under one form and closed under another. The predicate
   * closes the value with the quote it opened, so no pairing here is a string
   * literal at all and none of them may stand the assertion down.
   */
  const MISMATCHED_VALUE_QUOTES: FlagShape[] = STRING_QUOTES.flatMap((opening) =>
    STRING_QUOTES.filter(({ quote }) => quote !== opening.quote).map((closing) => ({
      name: `a value opened in ${opening.shape} and closed in ${closing.shape}`,
      source: envChunkBaking(
        `${E2E_BUILD_FLAG_NAME}:${opening.quote}${E2E_BUILD_FLAG_VALUE}${closing.quote}`
      ),
    }))
  );

  /** What a real E2E build emits, and the only thing that may suppress. */
  const RECOGNISED_FLAG_SHAPES: FlagShape[] = STRING_QUOTES.map(({ quote, shape }) => ({
    name: `the required value in ${shape}`,
    source: envChunkBaking(`${E2E_BUILD_FLAG_NAME}:${quote}${E2E_BUILD_FLAG_VALUE}${quote}`),
  }));

  /**
   * Everything else an artifact can carry around this flag. The predicate
   * recognises positively and has no fallback, so each of these leaves the
   * store assertion on — which is the direction a gate of this kind has to
   * fail in, and the direction a loosened pattern quietly gives up.
   */
  const UNRECOGNISED_FLAG_SHAPES: FlagShape[] = [
    { name: 'a chunk baking no flag at all', source: envChunkBaking('VITE_MODE:"production"') },
    { name: 'an empty value', source: envChunkBaking(`${E2E_BUILD_FLAG_NAME}:""`) },
    {
      name: 'the value unquoted, as a boolean rather than a string',
      source: envChunkBaking(`${E2E_BUILD_FLAG_NAME}:${E2E_BUILD_FLAG_VALUE}`),
    },
    {
      name: "a minifier's negated-zero truthiness idiom",
      source: envChunkBaking(`${E2E_BUILD_FLAG_NAME}:!0`),
    },
    {
      name: 'the value in upper case',
      source: envChunkBaking(`${E2E_BUILD_FLAG_NAME}:"${E2E_BUILD_FLAG_VALUE.toUpperCase()}"`),
    },
    {
      name: 'the value behind a leading space',
      source: envChunkBaking(`${E2E_BUILD_FLAG_NAME}:" ${E2E_BUILD_FLAG_VALUE}"`),
    },
    {
      name: 'a longer word the value only begins',
      source: envChunkBaking(`${E2E_BUILD_FLAG_NAME}:"${E2E_BUILD_FLAG_VALUE}ish"`),
    },
    {
      name: 'a template the value is interpolated into rather than stated in',
      source: envChunkBaking(
        `${E2E_BUILD_FLAG_NAME}:\`${E2E_BUILD_FLAG_VALUE.slice(0, 1)}\${x}${E2E_BUILD_FLAG_VALUE.slice(1)}\``
      ),
    },
    {
      name: 'a longer entry name ending in the flag',
      source: envChunkBaking(`APP_${E2E_BUILD_FLAG_NAME}:"${E2E_BUILD_FLAG_VALUE}"`),
    },
    {
      name: 'an entry name the flag only begins',
      source: envChunkBaking(`${E2E_BUILD_FLAG_NAME}_STORE:"${E2E_BUILD_FLAG_VALUE}"`),
    },
    {
      name: 'the flag compared against the value rather than keyed to it',
      source: `if(e.${E2E_BUILD_FLAG_NAME}==="${E2E_BUILD_FLAG_VALUE}"){}`,
    },
    ...MISMATCHED_VALUE_QUOTES,
  ];

  it.each(RECOGNISED_FLAG_SHAPES)('reads $name as an E2E build', ({ source }) => {
    expect(bakesE2eBuildFlag(source)).toBe(true);
  });

  it.each(UNRECOGNISED_FLAG_SHAPES)('does not read $name as an E2E build', ({ source }) => {
    expect(bakesE2eBuildFlag(source)).toBe(false);
  });

  // The required value is compared against the captured literal rather than
  // written into the pattern. Interpolated, a value carrying regex
  // metacharacters would match baked values it is not, and matching more here
  // suppresses more.
  it('does not let a metacharacter-bearing required value match a different baked value', () => {
    expect(bakesE2eBuildFlag(`const e={${E2E_BUILD_FLAG_NAME}:"true"};`, '.*')).toBe(false);
  });

  it('matches a metacharacter-bearing required value against exactly itself', () => {
    expect(bakesE2eBuildFlag(`const e={${E2E_BUILD_FLAG_NAME}:".*"};`, '.*')).toBe(true);
  });
});

describe('discoverTargetPinnedConfigs', () => {
  const REPO_ROOT = path.resolve(import.meta.dirname, '..');

  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-bundle-workspace-'));
    await fs.writeFile(path.join(workspaceRoot, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  async function writeWorkspace(
    name: string,
    scripts: Record<string, string> | undefined,
    configFileName: string
  ): Promise<void> {
    const directory = path.join(workspaceRoot, 'apps', name);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, 'package.json'),
      JSON.stringify({ name: `@stand-in/${name}`, scripts })
    );
    await fs.writeFile(path.join(directory, configFileName), 'export default {};\n');
  }

  it('covers the build config of a workspace that builds a shipped artifact', async () => {
    await writeWorkspace('shipper', { build: 'vite build' }, 'vite.config.ts');

    expect(discoverTargetPinnedConfigs(workspaceRoot)).toContain('apps/shipper/vite.config.ts');
  });

  it('leaves out a workspace whose config only ever serves a dev server', async () => {
    await writeWorkspace('tooling', { dev: 'vite' }, 'vite.config.ts');

    expect(discoverTargetPinnedConfigs(workspaceRoot)).toEqual([]);
  });

  it('leaves out a workspace whose manifest declares no scripts at all', async () => {
    await writeWorkspace('assets', undefined, 'vite.config.ts');

    expect(discoverTargetPinnedConfigs(workspaceRoot)).toEqual([]);
  });

  it('covers an Astro site alongside the Vite apps', async () => {
    await writeWorkspace('site', { build: 'astro build' }, 'astro.config.mjs');

    expect(discoverTargetPinnedConfigs(workspaceRoot)).toContain('apps/site/astro.config.mjs');
  });

  it("covers this repository's marketing site", () => {
    expect(discoverTargetPinnedConfigs(REPO_ROOT)).toContain('apps/marketing/astro.config.mjs');
  });
});

describe('collectBuildTargetViolations', () => {
  const REPO_ROOT = path.resolve(import.meta.dirname, '..');

  let configDir: string;

  beforeEach(async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-bundle-config-'));
  });

  afterEach(async () => {
    await fs.rm(configDir, { recursive: true, force: true });
  });

  /** Writes a stand-in shipping config and returns its repo-root-relative path. */
  async function writeConfig(body: string): Promise<string> {
    const configPath = path.join(configDir, 'vite.config.js');
    await fs.writeFile(configPath, body);
    return path.relative(REPO_ROOT, configPath);
  }

  /** Writes a stand-in Astro config, which nests its Vite options under `vite`. */
  async function writeAstroConfig(body: string): Promise<string> {
    const configPath = path.join(configDir, 'astro.config.mjs');
    await fs.writeFile(configPath, body);
    return path.relative(REPO_ROOT, configPath);
  }

  it('accepts every shipping config in this repository', async () => {
    expect(await collectBuildTargetViolations(REPO_ROOT)).toEqual([]);
  });

  it('accepts an Astro config that pins the target its nested Vite options build at', async () => {
    const configPath = await writeAstroConfig(
      `export default { vite: { build: { target: ${JSON.stringify(BUILD_TARGET)} } } };\n`
    );

    expect(await collectBuildTargetViolations(REPO_ROOT, [configPath])).toEqual([]);
  });

  it('reports an Astro config that nests no Vite options to build through', async () => {
    const configPath = await writeAstroConfig('export default { site: "https://example.test" };\n');

    const violations = await collectBuildTargetViolations(REPO_ROOT, [configPath]);

    expect(violations.join('\n')).toMatch(/pinned target/iu);
  });

  it('reports a shipping config that never imports the pinned target', async () => {
    const configPath = await writeConfig('export default {};\n');

    const violations = await collectBuildTargetViolations(REPO_ROOT, [configPath]);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(configPath);
    expect(violations[0]).toMatch(/pinned target/iu);
  });

  it('reports a shipping config whose emitted syntax floor sits below the pinned one', async () => {
    const configPath = await writeConfig(
      "export default { build: { target: ['chrome107', 'edge107', 'firefox104', 'safari16'] } };\n"
    );

    const violations = await collectBuildTargetViolations(REPO_ROOT, [configPath]);

    expect(violations.join('\n')).toMatch(/emits below/iu);
  });

  it('reports a shipping config whose emitted syntax floor sits above the pinned one', async () => {
    const configPath = await writeConfig(
      "export default { build: { target: ['chrome107', 'edge107', 'firefox104', 'safari17', 'ios17'] } };\n"
    );

    const violations = await collectBuildTargetViolations(REPO_ROOT, [configPath]);

    expect(violations.join('\n')).toMatch(/emits above/iu);
  });

  it('reports a shipping config that names no Apple floor at all', async () => {
    const configPath = await writeConfig("export default { build: { target: 'esnext' } };\n");

    const violations = await collectBuildTargetViolations(REPO_ROOT, [configPath]);

    expect(violations.join('\n')).toMatch(/leaves Safari and iOS unconstrained/iu);
  });

  it('reports a shipping config that turns transpilation off entirely', async () => {
    const configPath = await writeConfig('export default { build: { target: false } };\n');

    const violations = await collectBuildTargetViolations(REPO_ROOT, [configPath]);

    expect(violations.join('\n')).toMatch(/leaves Safari and iOS unconstrained/iu);
  });

  it('reports a shipping config that no longer loads', async () => {
    await fs.writeFile(path.join(configDir, 'seam.js'), 'export const OTHER = 1;\n');
    const configPath = await writeConfig(
      "import { BUILD_TARGET } from './seam.js';\nexport default { build: { target: BUILD_TARGET } };\n"
    );

    const violations = await collectBuildTargetViolations(REPO_ROOT, [configPath]);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(configPath);
    expect(violations[0]).toMatch(/could not be loaded/iu);
  });
});

describe('the iOS deployment target derived from the pinned build target', () => {
  const REPO_ROOT = path.resolve(import.meta.dirname, '..');

  let projectRoot: string;
  let projectFile: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-bundle-ios-'));
    projectFile = path.join(projectRoot, IOS_PROJECT_PATH);
    await fs.mkdir(path.dirname(projectFile), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  /** A project file carrying one build setting per build configuration. */
  async function writeProject(versions: readonly string[]): Promise<void> {
    await fs.writeFile(
      projectFile,
      versions
        .map((version) => `\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = ${version};\n`)
        .join('\t\t\t};\n')
    );
  }

  it('accepts the iOS project committed in this repository', () => {
    expect(collectDeploymentTargetViolations(REPO_ROOT)).toEqual([]);
  });

  it("covers all four of the committed project's build configurations", async () => {
    const committed = await fs.readFile(path.join(REPO_ROOT, IOS_PROJECT_PATH), 'utf8');

    expect(committed.match(/IPHONEOS_DEPLOYMENT_TARGET = 16\.4;/gu)).toHaveLength(4);
  });

  it('reports a project that sets no deployment target at all', async () => {
    await fs.writeFile(projectFile, 'buildSettings = {\n};\n');

    expect(collectDeploymentTargetViolations(projectRoot).join('\n')).toMatch(/sets no/u);
  });

  it('reports a project whose deployment target has drifted from the pinned floor', async () => {
    await writeProject(['15.0']);

    expect(collectDeploymentTargetViolations(projectRoot).join('\n')).toMatch(/15\.0/u);
  });

  it('points the drift message at the package script that regenerates the project', async () => {
    await writeProject(['15.0']);

    const message = collectDeploymentTargetViolations(projectRoot).join('\n');

    expect(message).toContain('pnpm verify:bundle:update');
    expect(message).not.toContain('tsx scripts/verify-bundle.ts');
  });

  it('rejects a pinned build target that names no iOS version to derive from', () => {
    expect(() => collectDeploymentTargetViolations(REPO_ROOT, ['chrome107'])).toThrow(/ios/iu);
  });

  it('writes the derived version into every build configuration', async () => {
    await writeProject(['15.0', '15.0', '15.0', '15.0']);

    writeDeploymentTarget(projectRoot);

    const written = await fs.readFile(projectFile, 'utf8');
    expect(written.match(/IPHONEOS_DEPLOYMENT_TARGET = 16\.4;/gu)).toHaveLength(4);
  });

  it('leaves a project already at the derived version untouched', async () => {
    await writeProject(['16.4', '16.4']);
    const before = await fs.readFile(projectFile, 'utf8');

    writeDeploymentTarget(projectRoot);

    expect(await fs.readFile(projectFile, 'utf8')).toBe(before);
  });
});

describe('collectBundleViolations for the pre-paint scripts in a built SPA shell', () => {
  let appDir: string;
  let shellDistribution: string;

  /** A shell carrying the named pre-paint scripts and nothing else of interest. */
  function shellCarrying(names: readonly string[]): string {
    const scripts = names.map((name) => `<script>${PRE_PAINT_SCRIPTS.get(name) ?? ''}</script>`);
    return `<!doctype html><html><head><meta charset="UTF-8" />${scripts.join('')}</head><body></body></html>`;
  }

  beforeEach(async () => {
    appDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-bundle-shell-'));
    shellDistribution = path.join(appDir, 'dist');
    await fs.mkdir(shellDistribution, { recursive: true });
    await fs.writeFile(path.join(shellDistribution, '_headers'), '/*\n  X-Frame-Options: DENY\n');
  });

  afterEach(async () => {
    await fs.rm(appDir, { recursive: true, force: true });
  });

  async function violationsForShell(html: string): Promise<string[]> {
    await fs.writeFile(path.join(shellDistribution, 'index.html'), html);
    return await collectBundleViolations({
      distributionDir: shellDistribution,
      shipsTts: false,
    });
  }

  it('reports every pre-paint script a shell is missing', async () => {
    const violations = await violationsForShell(shellCarrying([]));

    expect(violations).toEqual(
      [...PRE_PAINT_SCRIPTS.keys()].map((name) => expect.stringContaining(name))
    );
  });

  it('reports the one pre-paint script a shell is missing', async () => {
    const violations = await violationsForShell(shellCarrying(['theme']));

    expect(violations).toEqual([expect.stringContaining('accessibility')]);
  });

  it('accepts a shell carrying every pre-paint script', async () => {
    const violations = await violationsForShell(shellCarrying([...PRE_PAINT_SCRIPTS.keys()]));

    expect(violations).toEqual([]);
  });

  it('asks no pre-paint script of an origin that serves no SPA shell', async () => {
    const violations = await collectBundleViolations({
      distributionDir: shellDistribution,
      shipsTts: false,
    });

    expect(violations).toEqual([]);
  });
});

describe('declaredOpaqueProtocolLabels', () => {
  async function writeLibrary(modules: Record<string, string>): Promise<string> {
    const libraryDir = path.join(runtimeDir, 'opaque-lib');
    await fs.mkdir(libraryDir, { recursive: true });
    for (const [name, contents] of Object.entries(modules)) {
      await fs.writeFile(path.join(libraryDir, name), contents);
    }
    return libraryDir;
  }

  it('returns the protocol label a library module declares', async () => {
    const libraryDir = await writeLibrary({
      'common.js': "const info = 'OPAQUE-TestLabel';\n",
    });

    expect(await declaredOpaqueProtocolLabels(libraryDir)).toEqual(['OPAQUE-TestLabel']);
  });

  // A reader that stops at the first module leaves every label declared
  // elsewhere invisible to the assertion built on it, which is a guard
  // reporting green over exactly what it exists to catch.
  it('returns the labels of every module, not of the first', async () => {
    const libraryDir = await writeLibrary({
      'common.js': "const first = 'OPAQUE-FirstLabel';\n",
      'core_client.js': "const second = 'OPAQUE-SecondLabel';\n",
    });

    expect(await declaredOpaqueProtocolLabels(libraryDir)).toEqual([
      'OPAQUE-FirstLabel',
      'OPAQUE-SecondLabel',
    ]);
  });

  it('reads the installed library when given no directory', async () => {
    expect(await declaredOpaqueProtocolLabels()).toEqual(
      expect.arrayContaining([expect.stringMatching(/^OPAQUE-[A-Za-z]+$/u)])
    );
  });

  it('rejects a library source declaring no protocol labels', async () => {
    const libraryDir = await writeLibrary({ 'common.js': 'export const nothing = 1;\n' });

    await expect(declaredOpaqueProtocolLabels(libraryDir)).rejects.toThrow(/protocol label/u);
  });
});

describe('collectBundleViolations for the merged marketing chunks', () => {
  let mergeRoot: string;
  let mergedDistribution: string;

  /** The OPAQUE stack as a marketing chunk carries it: a protocol label survives
   * minification as a string literal, so it is what the artifact is searched
   * for. Derived from the installed library, never written down twice. */
  async function opaqueStackChunk(): Promise<string> {
    const [label] = await declaredOpaqueProtocolLabels();
    return `const i=new TextEncoder().encode("${String(label)}");`;
  }

  beforeEach(async () => {
    mergeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-bundle-merge-'));
    mergedDistribution = path.join(mergeRoot, 'dist');
    await fs.mkdir(mergedDistribution, { recursive: true });
    await fs.writeFile(path.join(mergedDistribution, '_headers'), '/*\n  X-Frame-Options: DENY\n');
  });

  afterEach(async () => {
    await fs.rm(mergeRoot, { recursive: true, force: true });
  });

  async function writeMergedFile(relativePath: string, content: string): Promise<void> {
    const absolute = path.join(mergedDistribution, relativePath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content);
  }

  it('reports a marketing chunk carrying the OPAQUE protocol stack', async () => {
    await writeMergedFile('_astro/encryption-demo.abc.js', await opaqueStackChunk());

    const violations = await collectBundleViolations({
      distributionDir: mergedDistribution,
      shipsTts: false,
    });

    const [label] = await declaredOpaqueProtocolLabels();
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('_astro/encryption-demo.abc.js');
    expect(violations[0]).toContain(label);
  });

  // The signed-in app authenticates over OPAQUE, so its own chunk carries these
  // labels legitimately. Nothing exempts it: it sits outside the marketing
  // chunk directory this check reads, which is the whole of its scope.
  it("leaves the app's own auth chunk carrying the same labels alone", async () => {
    await writeMergedFile('assets/auth-abc.js', await opaqueStackChunk());
    await writeMergedFile('_astro/welcome.abc.js', 'console.info("marketing");');

    const violations = await collectBundleViolations({
      distributionDir: mergedDistribution,
      shipsTts: false,
    });

    expect(violations).toEqual([]);
  });
});

/**
 * React DOM as the installed package holds it, resolved from the web app that
 * depends on it, so the marker is measured against the React this repository
 * actually bundles.
 */
function installedReactDomClient(build: 'development' | 'production'): string {
  const webPackageJson = path.resolve(import.meta.dirname, '../apps/web/package.json');
  const reactDomRoot = path.dirname(
    createRequire(webPackageJson).resolve('react-dom/package.json')
  );
  return path.join(reactDomRoot, 'cjs', `react-dom-client.${build}.js`);
}

describe("the marker that identifies React DOM's development build", () => {
  it('occurs in the installed development client', async () => {
    const source = await fs.readFile(installedReactDomClient('development'), 'utf8');

    expect(source).toContain(REACT_DEVELOPMENT_BUILD_MARKER);
  });

  it('does not occur in the installed production client', async () => {
    const source = await fs.readFile(installedReactDomClient('production'), 'utf8');

    expect(source).not.toContain(REACT_DEVELOPMENT_BUILD_MARKER);
  });
});

describe('collectBundleViolations for the React build a dist carries', () => {
  let reactRoot: string;
  let reactDistribution: string;

  /** A React island built against the production client, which carries no warning text. */
  const PRODUCTION_REACT_CHUNK = 'const r=hydrateRoot(el,node);';

  beforeEach(async () => {
    reactRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-bundle-react-'));
    reactDistribution = path.join(reactRoot, 'dist');
    await fs.mkdir(reactDistribution, { recursive: true });
    await fs.writeFile(path.join(reactDistribution, '_headers'), '/*\n  X-Frame-Options: DENY\n');
  });

  afterEach(async () => {
    await fs.rm(reactRoot, { recursive: true, force: true });
  });

  async function writeReactDistributionFile(relativePath: string, content: string): Promise<void> {
    const absolute = path.join(reactDistribution, relativePath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content);
  }

  // The web app is the one that ships TTS, so its branch is where an E2E build
  // meets this check; the E2E flag must not exempt the app's own chunks the way
  // it exempts the E2E-only modules.
  it("reports React's development build in an app chunk of an E2E build", async () => {
    const assets = await fakeRuntime();
    await selfHost(assets);
    await writeDistributionFile('assets/tts.worker-abc.js', 'const p="/ort/";');
    await writeDistributionFile('assets/platform-abc.js', E2E_BUILD_ENV_CHUNK);
    await writeDistributionFile('assets/app-abc.js', DEVELOPMENT_REACT_CHUNK);
    await writeDistributionFile('_astro/client.abc.js', DEVELOPMENT_REACT_CHUNK);

    const violations = await collectBundleViolations({
      distributionDir,
      shipsTts: true,
      ortAssets: assets,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('assets/app-abc.js');
    expect(violations[0]).toContain("React's development build");
  });

  it("reports React's development build in an app chunk of a build that is not an E2E build", async () => {
    await writeReactDistributionFile('assets/index-abc.js', DEVELOPMENT_REACT_CHUNK);

    const violations = await collectBundleViolations({
      distributionDir: reactDistribution,
      shipsTts: false,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('assets/index-abc.js');
  });

  it("accepts React's development build in the marketing islands of an E2E build", async () => {
    await writeReactDistributionFile('assets/platform-abc.js', E2E_BUILD_ENV_CHUNK);
    await writeReactDistributionFile('_astro/client.abc.js', DEVELOPMENT_REACT_CHUNK);

    expect(
      await collectBundleViolations({ distributionDir: reactDistribution, shipsTts: false })
    ).toEqual([]);
  });

  // The admin origin serves its framed copy of the marketing site under a path
  // prefix, so that copy's islands sit one directory below the dist root.
  it("accepts React's development build in a marketing copy served under a path prefix", async () => {
    await writeReactDistributionFile('assets/index-abc.js', MINIFIED_E2E_BUILD_ENV_CHUNK);
    await writeReactDistributionFile('preview/_astro/client.abc.js', DEVELOPMENT_REACT_CHUNK);

    expect(
      await collectBundleViolations({ distributionDir: reactDistribution, shipsTts: false })
    ).toEqual([]);
  });

  it("reports an E2E build whose marketing islands carry React's production build", async () => {
    await writeReactDistributionFile('assets/platform-abc.js', E2E_BUILD_ENV_CHUNK);
    await writeReactDistributionFile('_astro/client.abc.js', PRODUCTION_REACT_CHUNK);

    const violations = await collectBundleViolations({
      distributionDir: reactDistribution,
      shipsTts: false,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('_astro/');
    expect(violations[0]).toContain("React's development build");
  });

  it('asks no development-build island of a build that is not an E2E build', async () => {
    await writeReactDistributionFile('_astro/client.abc.js', PRODUCTION_REACT_CHUNK);

    expect(
      await collectBundleViolations({ distributionDir: reactDistribution, shipsTts: false })
    ).toEqual([]);
  });
});

describe('collectBundleViolations against the stack a build was invoked for', () => {
  let stackRoot: string;
  let stackDistribution: string;
  let stackEnvFile: string;

  /**
   * A generated frontend env file as the generator writes one: the header it
   * stamps, and one value per line under the prefix a bundler inlines.
   */
  async function writeStackEnvFile(lines: readonly string[]): Promise<void> {
    await fs.writeFile(
      stackEnvFile,
      ['# Auto-generated from packages/shared/src/env/env.config.ts', '', ...lines, ''].join('\n')
    );
  }

  /** The inlined `import.meta.env` object as an unminified build bakes it. */
  function bakedEnvChunk(entries: Readonly<Record<string, string>>): string {
    const fields = Object.entries(entries)
      .map(([key, value]) => `  "${key}": "${value}"`)
      .join(',\n');
    return `const env = {\n${fields}\n};\n`;
  }

  beforeEach(async () => {
    stackRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-bundle-stack-'));
    stackDistribution = path.join(stackRoot, 'dist');
    await fs.mkdir(stackDistribution, { recursive: true });
    await fs.writeFile(path.join(stackDistribution, '_headers'), '/*\n  X-Frame-Options: DENY\n');
    stackEnvFile = path.join(stackRoot, '.env.e2e');
  });

  afterEach(async () => {
    await fs.rm(stackRoot, { recursive: true, force: true });
  });

  async function writeStackFile(relativePath: string, content: string): Promise<void> {
    const absolute = path.join(stackDistribution, relativePath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content);
  }

  it('accepts a bundle baking every value the stack it was built for declares', async () => {
    await writeStackEnvFile(['VITE_API_URL="http://localhost:10500"', 'VITE_PLATFORM="web"']);
    await writeStackFile(
      'assets/index-abc.js',
      bakedEnvChunk({ VITE_API_URL: 'http://localhost:10500', VITE_PLATFORM: 'web' })
    );

    expect(
      await collectBundleViolations({
        distributionDir: stackDistribution,
        shipsTts: false,
        stackEnvFile,
      })
    ).toEqual([]);
  });

  it('reports a baked value that is another stack’s', async () => {
    await writeStackEnvFile(['VITE_API_URL="http://localhost:10500"', 'VITE_PLATFORM="web"']);
    await writeStackFile(
      'assets/index-abc.js',
      bakedEnvChunk({ VITE_API_URL: 'http://localhost:10400', VITE_PLATFORM: 'web' })
    );

    const violations = await collectBundleViolations({
      distributionDir: stackDistribution,
      shipsTts: false,
      stackEnvFile,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('VITE_API_URL');
    expect(violations[0]).toContain('assets/index-abc.js');
    expect(violations[0]).toContain('http://localhost:10400');
  });

  it('reports a baked key the stack it was built for declares nothing for', async () => {
    await writeStackEnvFile(['VITE_API_URL="http://localhost:10500"']);
    await writeStackFile(
      'assets/index-abc.js',
      bakedEnvChunk({
        VITE_API_URL: 'http://localhost:10500',
        VITE_HELCIM_JS_TOKEN: 'mock-helcim-js-token',
      })
    );

    const violations = await collectBundleViolations({
      distributionDir: stackDistribution,
      shipsTts: false,
      stackEnvFile,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('VITE_HELCIM_JS_TOKEN');
  });

  it('reports a declared value no built artifact bakes', async () => {
    await writeStackEnvFile(['VITE_API_URL="http://localhost:10500"', 'VITE_PLATFORM="web"']);
    await writeStackFile('assets/index-abc.js', bakedEnvChunk({ VITE_PLATFORM: 'web' }));

    const violations = await collectBundleViolations({
      distributionDir: stackDistribution,
      shipsTts: false,
      stackEnvFile,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('VITE_API_URL');
  });

  it('compares the values a minified build bakes as template literals', async () => {
    await writeStackEnvFile(['VITE_API_URL="http://localhost:10500"']);
    await writeStackFile(
      'assets/index-abc.js',
      'const $e={VITE_API_URL:`http://localhost:10400`};'
    );

    const violations = await collectBundleViolations({
      distributionDir: stackDistribution,
      shipsTts: false,
      stackEnvFile,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('http://localhost:10400');
  });

  it('reads a generated value the generator single-quoted', async () => {
    await writeStackEnvFile([`VITE_API_URL='http://localhost:10500'`]);
    await writeStackFile(
      'assets/index-abc.js',
      bakedEnvChunk({ VITE_API_URL: 'http://localhost:10500' })
    );

    expect(
      await collectBundleViolations({
        distributionDir: stackDistribution,
        shipsTts: false,
        stackEnvFile,
      })
    ).toEqual([]);
  });

  it('reads a generated value the generator left unquoted', async () => {
    await writeStackEnvFile(['VITE_API_URL=http://localhost:10500']);
    await writeStackFile(
      'assets/index-abc.js',
      bakedEnvChunk({ VITE_API_URL: 'http://localhost:10500' })
    );

    expect(
      await collectBundleViolations({
        distributionDir: stackDistribution,
        shipsTts: false,
        stackEnvFile,
      })
    ).toEqual([]);
  });

  // A generated file carries lines that are not a prefixed assignment at all —
  // its own header, and the blank line under it.
  it('reads only the prefixed assignments of the generated file', async () => {
    await writeStackEnvFile(['HB_ENV_MODE=e2e', 'VITE_API_URL="http://localhost:10500"']);
    await writeStackFile(
      'assets/index-abc.js',
      bakedEnvChunk({ VITE_API_URL: 'http://localhost:10500' })
    );

    expect(
      await collectBundleViolations({
        distributionDir: stackDistribution,
        shipsTts: false,
        stackEnvFile,
      })
    ).toEqual([]);
  });

  it('names every file carrying one wrong value, each once', async () => {
    await writeStackEnvFile(['VITE_API_URL="http://localhost:10500"']);
    const wrong = bakedEnvChunk({ VITE_API_URL: 'http://localhost:10400' });
    await writeStackFile('assets/index-abc.js', `${wrong}${wrong}`);
    await writeStackFile('assets/auth-abc.js', wrong);

    const violations = await collectBundleViolations({
      distributionDir: stackDistribution,
      shipsTts: false,
      stackEnvFile,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('assets/auth-abc.js, assets/index-abc.js');
  });

  // An error-code constant ends in the prefixed name of no variable; reading one
  // as a baked value would fail every bundle the app's own error map ships in.
  it('reads no baked value out of a longer identifier ending in the prefix', async () => {
    await writeStackEnvFile(['VITE_API_URL="http://localhost:10500"']);
    await writeStackFile(
      'assets/index-abc.js',
      `const e={INVITE_API_URL:"INVITE_ACCEPT_FAILED"};\n` +
        bakedEnvChunk({ VITE_API_URL: 'http://localhost:10500' })
    );

    expect(
      await collectBundleViolations({
        distributionDir: stackDistribution,
        shipsTts: false,
        stackEnvFile,
      })
    ).toEqual([]);
  });

  // The command-line verifier runs over whatever a directory holds, including
  // the OTA dists a native build writes outside the generated file altogether,
  // so it names no stack and this comparison does not run.
  it('compares nothing when the caller names no stack', async () => {
    await writeStackEnvFile(['VITE_API_URL="http://localhost:10500"']);
    await writeStackFile(
      'assets/index-abc.js',
      bakedEnvChunk({ VITE_API_URL: 'http://localhost:10400' })
    );

    expect(
      await collectBundleViolations({ distributionDir: stackDistribution, shipsTts: false })
    ).toEqual([]);
  });
});

describe('the mode the bundle checks apply in', () => {
  it('checks the mode a shipping bundle is built under', () => {
    expect(shipsBundlesIn(Mode.Production)).toBe(true);
  });

  it('checks no other mode, because none of them builds a shipping bundle', () => {
    const others = Object.values(Mode).filter((mode) => mode !== Mode.Production);

    expect(others.map((mode) => shipsBundlesIn(mode))).toEqual(others.map(() => false));
  });

  it('names the mode the run is in when it has no shipping bundle to check', () => {
    expect(noShippingBundlesNotice(Mode.Development)).toContain(Mode.Development);
  });

  it('names the mode that does build one, so the reader knows where the checks run', () => {
    expect(noShippingBundlesNotice(Mode.E2E)).toContain(Mode.Production);
  });
});
