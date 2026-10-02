/**
 * Guards on what the shipping configs pin, rather than on what a build emitted:
 * the browser baseline every client chunk is compiled down to, and the iOS
 * deployment target the generated Xcode project carries.
 *
 * This module is Node-side build tooling: a browser-targeted bundle importing
 * it builds, then throws a TypeError at load.
 */

import { existsSync, promises as fs, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build, loadConfigFromFile, resolveConfig, type InlineConfig, type UserConfig } from 'vite';
import { discoverWorkspaces } from '../cli/workspaces.ts';
import { BUILD_TARGET } from './seam.ts';

/**
 * The build config filenames this check knows how to read, mapped to where each
 * builder keeps the Vite options that emit its client chunks: Vite's are the
 * config itself, Astro's are nested under a `vite` key. The shape has to be
 * known, not guessed — handed an Astro config as if it were a Vite one, the
 * resolver sees no `build.target` at all and reports a pinned config as unpinned.
 */
const BUILD_CONFIG_SHAPES = new Map<string, 'vite' | 'astro'>([
  ['vite.config.ts', 'vite'],
  ['astro.config.mjs', 'astro'],
]);

/** A stand-in config written by a test is a plain Vite one. */
function configShape(configPath: string): 'vite' | 'astro' {
  return BUILD_CONFIG_SHAPES.get(path.basename(configPath)) ?? 'vite';
}

/** Workspace discovery only yields directories that have a manifest to read. */
function declaresBuildScript(workspaceDir: string): boolean {
  const manifest = JSON.parse(readFileSync(path.join(workspaceDir, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  return manifest.scripts?.['build'] !== undefined;
}

/**
 * The build configs that emit JavaScript into a shipped artifact. Each one must
 * take its `build.target` from `BUILD_TARGET`; a build that silently inherits
 * the bundler's own default is the failure this check exists to catch, and
 * `apps/admin` was exactly that until it started importing the constant.
 *
 * Discovered rather than listed, because a hand-kept list leaves every app added
 * after it was written unchecked, and silently: that is how `apps/marketing`
 * shipped unpinned. A workspace that declares a `build` script produces a
 * shipped artifact, and the config it builds through is what sets the target, so
 * those two facts are the membership rule.
 *
 * One bound survives: a workspace that builds through neither of the known
 * config filenames is invisible here. `apps/sandbox` is that case today — it
 * builds through its own script, and nothing in it resolves a Vite target to
 * read.
 */
export function discoverTargetPinnedConfigs(repoRoot: string): string[] {
  return discoverWorkspaces(repoRoot)
    .filter((workspace) => declaresBuildScript(path.join(repoRoot, workspace.path)))
    .flatMap((workspace) =>
      [...BUILD_CONFIG_SHAPES.keys()]
        .map((fileName) => `${workspace.path}/${fileName}`)
        .filter((configPath) => existsSync(path.join(repoRoot, configPath)))
    );
}

/**
 * Two regex literals that bracket the pinned floor from both sides. A lookbehind
 * parses from Safari/iOS 16.4; RegExp set notation (the `v` flag) only from
 * Safari/iOS 17. So a build at the floor keeps the first literal and rewrites
 * the second into a `new RegExp` call, and neither neighbouring version does
 * both.
 *
 * These are stated independently of `BUILD_TARGET` on purpose. Deriving the
 * expectation from the constant would make any edit to the constant
 * self-consistent, which is the tautology this check exists to avoid — moving
 * the floor has to be stated twice, as a value and as the syntax it admits.
 */
const RAW_LOOKBEHIND = String.raw`/(?<=a)b/g`;
const RAW_SET_NOTATION = String.raw`/[\p{ASCII}--[a-z]]/v`;

const FLOOR_PROBE_SOURCE = [
  `export const belowFloor = ${RAW_LOOKBEHIND};`,
  `export const aboveFloor = ${RAW_SET_NOTATION};`,
  '',
].join('\n');

/** The entries bound to `IPHONEOS_DEPLOYMENT_TARGET` and to desktop Safari. */
const APPLE_TARGET = /^(?:safari|ios)/u;

/**
 * Build the probe at `target` and read the bytes back off disk, so what the
 * check reads is emitted output rather than the config value that produced it.
 */
async function emitFloorProbe(target: string | string[]): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'build-target-probe-'));
  try {
    const entry = path.join(directory, 'probe.js');
    await fs.writeFile(entry, FLOOR_PROBE_SOURCE);
    const outDir = path.join(directory, 'out');
    await build({
      configFile: false,
      logLevel: 'silent',
      root: directory,
      build: {
        target,
        minify: false,
        outDir,
        lib: { entry, formats: ['es'], fileName: 'probe' },
      },
    });
    return await fs.readFile(path.join(outDir, 'probe.mjs'), 'utf8');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

/**
 * Assert each listed build compiles to the pinned Safari/iOS syntax floor.
 *
 * Two legs, because neither covers the other. The emitted-floor leg proves the
 * target a config resolves to actually reaches emitted output, so it catches a
 * pin that is set but inert as well as an Apple entry edited in either
 * direction. The identity leg catches a config that never imports the constant
 * — measured, that one is invisible in emitted bytes today, because the pinned
 * value and Vite's current default lower identical syntax.
 *
 * Two bounds, both deliberate. The emitted leg reads the Apple entries only, so
 * a Chrome/Edge/Firefox entry can move in either direction unseen — lowering
 * one ships more-lowered output, raising one leaves the bytes unchanged because
 * the lowest entry governs — and widening the probe back to the whole list
 * would reinstate the masking described at the call site. And for an Astro site
 * both legs read the user config, which the builder merges its own defaults over
 * — so they prove the pin is stated, and only a real build proves it is honoured.
 */
export async function collectBuildTargetViolations(
  repoRoot: string,
  configPaths: readonly string[] = discoverTargetPinnedConfigs(repoRoot)
): Promise<string[]> {
  const perConfig = await Promise.all(
    configPaths.map(async (configPath) => configTargetViolations(repoRoot, configPath))
  );
  return perConfig.flat();
}

/** The Safari/iOS entries of a resolved target, which may be a bare string or off. */
function appleEntriesOf(target: false | string | string[] | undefined): string[] {
  if (typeof target === 'string') {
    return [target].filter((entry) => APPLE_TARGET.test(entry));
  }
  if (Array.isArray(target)) {
    return target.filter((entry) => APPLE_TARGET.test(entry));
  }
  return [];
}

/**
 * An Astro config is not a Vite config, so it cannot be handed to Vite's own
 * loader as one. Loading it and resolving the `vite` key it carries reads the
 * options Astro will merge into its client build.
 */
async function astroClientConfig(configFile: string): Promise<InlineConfig> {
  const loaded = await loadConfigFromFile(
    { command: 'build', mode: 'production' },
    configFile,
    path.dirname(configFile),
    'silent'
  );
  const astroConfig = loaded?.config as { vite?: UserConfig } | undefined;
  return { ...astroConfig?.vite, configFile: false };
}

async function resolvedClientTarget(configFile: string): Promise<false | string | string[]> {
  const inline: InlineConfig =
    configShape(configFile) === 'astro' ? await astroClientConfig(configFile) : { configFile };
  // The client environment, not the top-level `build`, is what emits the
  // browser chunks, and a per-environment override would not show up above it.
  const resolved = await resolveConfig(
    { ...inline, root: path.dirname(configFile), logLevel: 'silent' },
    'build'
  );
  /* v8 ignore next -- a build resolution always carries a client environment with a resolved
     target, so both fallbacks here are the compiler's index and nullish checks rather than cases */
  return resolved.environments['client']?.build.target ?? false;
}

async function configTargetViolations(repoRoot: string, configPath: string): Promise<string[]> {
  const configFile = path.resolve(repoRoot, configPath);
  let target: false | string | string[];
  try {
    target = await resolvedClientTarget(configFile);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return [`${configPath} could not be loaded, so the target it ships at is unknown: ${reason}`];
  }

  const violations: string[] = [];
  if (JSON.stringify(target) !== JSON.stringify(BUILD_TARGET)) {
    violations.push(
      `${configPath} does not build at the pinned target: it resolves to ` +
        `${JSON.stringify(target)}, the pin is ${JSON.stringify(BUILD_TARGET)} — ` +
        `the config does not import BUILD_TARGET, or overrides it after importing it`
    );
  }

  // Probed on the Safari/iOS entries alone, never the whole list. A browser
  // entry lower than the Apple one masks it: `chrome107` already forces set
  // notation to be lowered, so a target raised from `safari16.4` to `safari17`
  // emits identical bytes and the raise — the direction that ships syntax the
  // deployment target cannot parse — goes unseen.
  const appleFloor = appleEntriesOf(target);
  if (appleFloor.length === 0) {
    violations.push(
      `${configPath} leaves Safari and iOS unconstrained: it builds at ` +
        `${JSON.stringify(target)}, which names no Apple floor at all, so nothing ` +
        `holds its output down to what the iOS deployment target can parse`
    );
    return violations;
  }

  const emitted = await emitFloorProbe(appleFloor);
  if (!emitted.includes(RAW_LOOKBEHIND)) {
    violations.push(
      `${configPath} emits below the pinned syntax floor: it lowered a lookbehind ` +
        `that Safari and iOS 16.4 parse natively, so its target is older than the floor`
    );
  }
  if (emitted.includes(RAW_SET_NOTATION)) {
    violations.push(
      `${configPath} emits above the pinned syntax floor: it kept RegExp set notation ` +
        `raw, which fails to parse below Safari and iOS 17 — every chunk in that build ` +
        `is a syntax error on a device the app still installs on`
    );
  }
  return violations;
}

/**
 * The Xcode project whose `IPHONEOS_DEPLOYMENT_TARGET` decides which iOS
 * versions the app installs on, and so which syntax its WebView has to parse.
 * `cap sync` does not write this setting — it rewrites only the bundle
 * identifier and display name — so a value generated here survives every sync;
 * `cap migrate` is the one command that would overwrite it.
 */
export const IOS_PROJECT_PATH = 'apps/web/ios/App/App.xcodeproj/project.pbxproj';

const IOS_TARGET_ENTRY = /^ios(?<version>\d[\d.]*)$/u;
const DEPLOYMENT_TARGET_SETTING = /IPHONEOS_DEPLOYMENT_TARGET = (?<version>[^;]+);/gu;

/**
 * The iOS version behind the pinned syntax floor. Deriving it is what stops the
 * project and the build target from stating the same decision twice and drifting
 * apart: the floor was raised in one of the two places and not the other before
 * anything connected them.
 */
function iosVersionOf(target: readonly string[]): string {
  const version = target
    .map((entry) => IOS_TARGET_ENTRY.exec(entry)?.groups?.['version'])
    .find((candidate) => candidate !== undefined);
  if (version === undefined) {
    throw new Error(
      `the pinned build target names no ios entry, so no IPHONEOS_DEPLOYMENT_TARGET ` +
        `can be derived from it: ${JSON.stringify(target)}`
    );
  }
  return version;
}

/** Assert the committed Xcode project carries the derived deployment target. */
export function collectDeploymentTargetViolations(
  repoRoot: string,
  target: readonly string[] = BUILD_TARGET
): string[] {
  const version = iosVersionOf(target);
  const source = readFileSync(path.join(repoRoot, IOS_PROJECT_PATH), 'utf8');
  const settings = [...source.matchAll(DEPLOYMENT_TARGET_SETTING)].map(
    (match) => match.groups?.['version']
  );

  if (settings.length === 0) {
    return [
      `${IOS_PROJECT_PATH} sets no IPHONEOS_DEPLOYMENT_TARGET at all, so the iOS ` +
        `versions the app installs on are whatever the toolchain defaults to, and ` +
        `nothing holds them to the ${version} the bundle is built for`,
    ];
  }

  const stale = [...new Set(settings.filter((setting) => setting !== version))];
  if (stale.length === 0) return [];
  return [
    `${IOS_PROJECT_PATH} deploys to ${stale.join(', ')} where the pinned build ` +
      `target derives ${version} — regenerate it with ` +
      `\`pnpm verify:bundle:update\` and commit the result`,
  ];
}

/** Generate the deployment target into the project, every build configuration. */
export function writeDeploymentTarget(
  repoRoot: string,
  target: readonly string[] = BUILD_TARGET
): void {
  const version = iosVersionOf(target);
  const projectFile = path.join(repoRoot, IOS_PROJECT_PATH);
  const source = readFileSync(projectFile, 'utf8');
  const generated = source.replaceAll(
    DEPLOYMENT_TARGET_SETTING,
    `IPHONEOS_DEPLOYMENT_TARGET = ${version};`
  );
  if (generated !== source) writeFileSync(projectFile, generated);
}
