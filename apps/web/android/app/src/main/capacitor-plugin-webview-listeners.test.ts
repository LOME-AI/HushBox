/**
 * Every installed Capacitor plugin that ships Android sources, checked for one
 * property: its `onRenderProcessGone` override, if it has one, never answers
 * with anything but `false`.
 *
 * Why this matters and why it lives here rather than beside `MainActivity.java`:
 * `@capacitor/android`'s `BridgeWebViewClient` calls every registered
 * `WebViewListener`'s `onRenderProcessGone` and ORs their answers together, so a
 * `true` from *any* plugin spares the app process regardless of what
 * `MainActivity`'s own override — and its recovery bound — just decided. That
 * fact lives only in `node_modules`: no source file in this repository
 * registers the offending listener, so a guard scoped to this repository's own
 * sources, however carefully written, cannot see it. Reading a third-party
 * package's source in a test is a deliberate exception to normal test practice,
 * made here because the risk it guards is real: at the time this test was
 * written, `@capgo/capacitor-updater` overrode the callback and correctly
 * returned `false` — but nothing was watching that fact, and a future version
 * bump, or an entirely different plugin added later, could invert it silently.
 *
 * **Plugin discovery.** A Capacitor plugin advertises Android sources by
 * declaring `capacitor.android.src` in its own `package.json` — the same
 * convention `@capacitor/cli`'s own `sync` reads. This file walks
 * `apps/web/package.json`'s production `dependencies` (never `devDependencies`
 * — a dev-only tool such as `@capacitor/cli` itself never ships into the built
 * app, so it cannot register a listener at runtime), resolves each one's
 * `package.json` through Node's own module resolution, and reads that field.
 * This is deliberately not a `node_modules` directory walk: an early audit of
 * this exact override searched with `grep -r` and returned a confident false
 * negative, because `grep -r` does not follow the symlinked package
 * directories pnpm's `node_modules` is built from — a plugin's real files sit
 * in the pnpm store, reached through a symlink `grep -r` never enters.
 *
 * The resolution itself is `require.resolve.paths(name)` — the ordered list
 * of `node_modules` directories Node's own resolver would search for `name` —
 * checked for a `package.json` in each, stopping at the first hit. Not
 * `require.resolve(`${name}/package.json`)`: that throws for a package whose
 * `exports` map does not list a `./package.json` subpath, which
 * `@huggingface/transformers` — a real, fully-resolvable production
 * dependency here — does, discovered while writing this file. `paths()`
 * sidesteps `exports` entirely: it asks Node where it would look, the same
 * symlink-following answer `require.resolve` itself would give, without
 * routing through a subpath `exports` can restrict.
 *
 * **Scope note.** `@capacitor-community/fcm` is scanned like every other
 * plugin even though app code calls it only on iOS: `cap sync` wires every
 * plugin that declares `capacitor.android.src` into the Android build, and the
 * bridge loads each one at startup, so its listeners register whether or not
 * app code ever calls it.
 *
 * **Return-value classification.** A `return` is classified as `false` (fine),
 * `true` (a violation — the whole point of this file), or unclassifiable (a
 * variable, a method call, a ternary) — the last case fails loudly rather than
 * guessing, since guessing which way an opaque expression resolves is exactly
 * the kind of silent gap this file exists to close. The signature match
 * accepts both Java (`boolean onRenderProcessGone(`) and Kotlin
 * (`fun onRenderProcessGone(`) declarations, and the return-statement match
 * accepts a trailing `;` or a bare newline, so a Kotlin override — none exists
 * among installed plugins today — is not silently skipped merely for omitting
 * Java's semicolon.
 *
 * **False-positive/negative boundary.** Comments and string/character literals
 * are emptied before any of the above runs, the same left-to-right pass
 * `MainActivity.test.ts` uses, with the same documented limitation: an escaped
 * quote inside a literal ends the match early and widens the scope past it —
 * a false-red risk, never a false green. Return-statement matching reads
 * every `return` inside an override's braces at any nesting depth, not only
 * its own top level, which means a `return true;` inside some unrelated nested
 * lambda in the same override body would also be flagged — again false-red,
 * never false-green, and accepted for the same reason `MainActivity.test.ts`
 * accepts a widened false-red surface: a false red costs a cycle, a false
 * green costs the feature. What this file cannot see at all: a listener a
 * plugin registers through some mechanism other than a class with a
 * `boolean`/`Boolean`-returning `onRenderProcessGone` override reachable by
 * text search — reflection, bytecode generation, or a native (C++/JNI)
 * implementation, none of which any installed plugin here uses.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const WEB_PACKAGE_JSON = path.join(import.meta.dirname, '../../../../package.json');
const JAVA_SIGNATURE = 'boolean onRenderProcessGone(';
const KOTLIN_SIGNATURE = 'fun onRenderProcessGone(';
const RETURN_STATEMENT = /return\s+([^;\n]+)[;\n]/g;
const COMMENT_OR_LITERAL = /"[^"\n]*"|'[^'\n]*'|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

const require = createRequire(import.meta.url);

interface ResolvedPlugin {
  readonly name: string;
  readonly androidSourceDir: string;
}

/**
 * Resolves one production dependency to its Capacitor Android plugin
 * descriptor, or `null` when the package declares no `capacitor.android`
 * field — how `@capacitor/core`, `@capacitor/android` and `@capacitor/ios`
 * (present as dependencies, no such field) are correctly not plugins.
 *
 * `resolvePackageJsonPath` is Node's own module resolution, injected so the
 * two failure-loud branches below are reachable with a synthetic tree instead
 * of mutating the real installed one, and so its own failure — a dependency
 * that cannot be resolved at all — propagates unmodified rather than being
 * caught and treated as "not a plugin".
 */
function resolvePlugin(
  name: string,
  resolvePackageJsonPath: (name: string) => string
): ResolvedPlugin | null {
  const packageJsonPath = resolvePackageJsonPath(name);
  const package_ = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    capacitor?: { android?: { src?: string } };
  };
  const androidSource = package_.capacitor?.android?.src;
  if (androidSource === undefined) {
    return null;
  }
  const androidSourceDir = path.join(path.dirname(packageJsonPath), androidSource);
  if (!statSync(androidSourceDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(
      `${name} declares capacitor.android.src "${androidSource}" but ${androidSourceDir} does not exist`
    );
  }
  return { name, androidSourceDir };
}

/** Every `.java`/`.kt` file under `dir`, however deeply nested. */
function findJavaAndKotlinFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return findJavaAndKotlinFiles(entryPath);
    }
    return /\.(java|kt)$/.test(entry.name) ? [entryPath] : [];
  });
}

/**
 * `source` with comments and string/character literals emptied, so neither
 * can be read out of the other — see the file-level comment's false-positive
 * boundary for what this does and does not protect against.
 */
function stripCommentsAndLiterals(source: string): string {
  return source.replaceAll(COMMENT_OR_LITERAL, (match) =>
    match.startsWith('/') ? ' ' : match.charAt(0).repeat(2)
  );
}

/** The balanced `{ … }` block opening at or after `from`, or empty when there is none. */
function blockFrom(source: string, from: number): string {
  const open = source.indexOf('{', from);
  if (open === -1) {
    return '';
  }
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') {
      depth += 1;
    } else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(open, index + 1);
      }
    }
  }
  return '';
}

/** Every `onRenderProcessGone` override body in one file's cleaned source, Java or Kotlin. */
function findOverrideBodies(cleanedSource: string): string[] {
  const bodies: string[] = [];
  for (const signature of [JAVA_SIGNATURE, KOTLIN_SIGNATURE]) {
    let from = 0;
    for (;;) {
      const index = cleanedSource.indexOf(signature, from);
      if (index === -1) {
        break;
      }
      bodies.push(blockFrom(cleanedSource, index));
      from = index + signature.length;
    }
  }
  return bodies;
}

/** Every expression a `return` statement inside `body` hands back, verbatim. */
function returnExpressions(body: string): string[] {
  return [...body.matchAll(RETURN_STATEMENT)].map((match) => (match[1] ?? '').trim());
}

/**
 * Throws unless every `return` inside `body` is the literal `false`. An empty
 * `return` list means the signature matched but no return was found inside —
 * treated as unclassifiable rather than vacuously fine, since a real override
 * of a `boolean`-returning callback always returns one.
 */
function assertOverrideAlwaysReturnsFalse(label: string, body: string): void {
  const expressions = returnExpressions(body);
  if (expressions.length === 0) {
    throw new Error(
      `${label}: found the onRenderProcessGone signature but no return statement inside it`
    );
  }
  for (const expression of expressions) {
    if (expression === 'true') {
      throw new Error(
        `${label}: onRenderProcessGone returns true, which spares the app process regardless ` +
          `of MainActivity's recovery bound — Capacitor ORs every registered listener's answer`
      );
    }
    if (expression !== 'false') {
      throw new Error(
        `${label}: onRenderProcessGone returns "${expression}", not a boolean literal — cannot ` +
          `classify whether it can ever answer true`
      );
    }
  }
}

function readWebDependencyNames(): string[] {
  const package_ = JSON.parse(readFileSync(WEB_PACKAGE_JSON, 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  return Object.keys(package_.dependencies ?? {});
}

/**
 * `name`'s own `package.json`, found by checking Node's own module search
 * path list for it — see the file-level comment's Plugin discovery section
 * for why this, and not a subpath `require.resolve`, is the resolution used.
 */
function nodeResolvePackageJsonPath(name: string): string {
  for (const dir of require.resolve.paths(name) ?? []) {
    const candidate = path.join(dir, name, 'package.json');
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`cannot find ${name}'s package.json in any of Node's module search paths`);
}

function resolveInstalledPlugins(): ResolvedPlugin[] {
  return readWebDependencyNames()
    .map((name) => resolvePlugin(name, nodeResolvePackageJsonPath))
    .filter((plugin): plugin is ResolvedPlugin => plugin !== null);
}

describe('resolvePlugin', () => {
  let scratchDir: string;

  beforeEach(() => {
    scratchDir = mkdtempSync(path.join(os.tmpdir(), 'capacitor-plugin-fixture-'));
  });

  afterEach(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  function fixturePackageJson(content: unknown): (specifier: string) => string {
    const packageJsonPath = path.join(scratchDir, 'package.json');
    writeFileSync(packageJsonPath, JSON.stringify(content));
    return () => packageJsonPath;
  }

  it('returns null when the package declares no capacitor field', () => {
    const resolve = fixturePackageJson({ name: 'not-a-plugin' });
    expect(resolvePlugin('not-a-plugin', resolve)).toBeNull();
  });

  it('resolves the android source directory when the package declares one', () => {
    mkdirSync(path.join(scratchDir, 'android'));
    const resolve = fixturePackageJson({
      name: 'a-plugin',
      capacitor: { android: { src: 'android' } },
    });
    expect(resolvePlugin('a-plugin', resolve)).toEqual({
      name: 'a-plugin',
      androidSourceDir: path.join(scratchDir, 'android'),
    });
  });

  it('fails loudly, rather than skipping, when capacitor.android.src names a directory that does not exist', () => {
    const resolve = fixturePackageJson({
      name: 'a-plugin',
      capacitor: { android: { src: 'android' } },
    });
    expect(() => resolvePlugin('a-plugin', resolve)).toThrow(/does not exist/);
  });

  it('fails loudly, rather than skipping, when the package cannot be resolved at all', () => {
    const resolve = (): string => {
      throw new Error('Cannot find module');
    };
    expect(() => resolvePlugin('missing-package', resolve)).toThrow('Cannot find module');
  });
});

describe('findJavaAndKotlinFiles', () => {
  let scratchDir: string;

  beforeEach(() => {
    scratchDir = mkdtempSync(path.join(os.tmpdir(), 'capacitor-plugin-files-'));
  });

  afterEach(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it('finds .java and .kt files nested in subdirectories, and nothing else', () => {
    mkdirSync(path.join(scratchDir, 'a', 'b'), { recursive: true });
    writeFileSync(path.join(scratchDir, 'Top.java'), '');
    writeFileSync(path.join(scratchDir, 'a', 'b', 'Nested.kt'), '');
    writeFileSync(path.join(scratchDir, 'a', 'Readme.md'), '');

    const found = findJavaAndKotlinFiles(scratchDir)
      .map((filePath) => path.relative(scratchDir, filePath))
      .toSorted((a, b) => a.localeCompare(b));

    expect(found).toEqual(
      [path.join('a', 'b', 'Nested.kt'), 'Top.java'].toSorted((a, b) => a.localeCompare(b))
    );
  });
});

describe('findOverrideBodies', () => {
  it('finds a Java override body', () => {
    const source =
      'class X { public boolean onRenderProcessGone(WebView v, Detail d) { return false; } }';
    expect(findOverrideBodies(stripCommentsAndLiterals(source))).toEqual(['{ return false; }']);
  });

  it('finds a Kotlin override body', () => {
    const source =
      'class X : WebViewListener() {\n' +
      '  override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {\n' +
      '    return false\n' +
      '  }\n' +
      '}';
    expect(findOverrideBodies(stripCommentsAndLiterals(source))).toEqual([
      '{\n    return false\n  }',
    ]);
  });

  it('does not mistake a commented-out override for a real one', () => {
    const source =
      '// boolean onRenderProcessGone(WebView v, Detail d) { return true; }\nclass X {}';
    expect(findOverrideBodies(stripCommentsAndLiterals(source))).toEqual([]);
  });

  it('finds every override when a file registers more than one', () => {
    const source =
      'boolean onRenderProcessGone(A a, B b) { return false; } ' +
      'boolean onRenderProcessGone(A a, B b) { return true; }';
    expect(findOverrideBodies(stripCommentsAndLiterals(source))).toHaveLength(2);
  });
});

describe('assertOverrideAlwaysReturnsFalse', () => {
  it('accepts an override that always returns false', () => {
    expect(() => {
      assertOverrideAlwaysReturnsFalse('plugin', '{ return false; }');
    }).not.toThrow();
  });

  it('accepts an override whose every branch returns false', () => {
    expect(() => {
      assertOverrideAlwaysReturnsFalse('plugin', '{ if (x) { return false; } return false; }');
    }).not.toThrow();
  });

  it('accepts a Kotlin return with no trailing semicolon', () => {
    expect(() => {
      assertOverrideAlwaysReturnsFalse('plugin', '{\n  return false\n}');
    }).not.toThrow();
  });

  it('fails loudly when a branch returns true', () => {
    expect(() => {
      assertOverrideAlwaysReturnsFalse('plugin', '{ return true; }');
    }).toThrow(/returns true/);
  });

  it('fails loudly on a return expression that is a variable, not a literal', () => {
    expect(() => {
      assertOverrideAlwaysReturnsFalse('plugin', '{ return recovered; }');
    }).toThrow(/cannot classify/);
  });

  it('fails loudly on a return expression that is a method call, not a literal', () => {
    expect(() => {
      assertOverrideAlwaysReturnsFalse('plugin', '{ return shouldRecover(detail); }');
    }).toThrow(/cannot classify/);
  });

  it('fails loudly when the signature matched but no return statement is inside', () => {
    expect(() => {
      assertOverrideAlwaysReturnsFalse('plugin', '{ log(detail); }');
    }).toThrow(/no return statement/);
  });
});

describe('installed Capacitor plugins on Android: onRenderProcessGone answers', () => {
  const plugins = resolveInstalledPlugins();

  it('discovers at least one Android plugin, so a broken discovery cannot pass by finding nothing', () => {
    expect(plugins.length).toBeGreaterThan(0);
  });

  it('discovers @capgo/capacitor-updater, which registers this callback today', () => {
    expect(plugins.map((plugin) => plugin.name)).toContain('@capgo/capacitor-updater');
  });

  it('actually examines at least one onRenderProcessGone override, not zero', () => {
    const overrideCount = plugins
      .flatMap((plugin) => findJavaAndKotlinFiles(plugin.androidSourceDir))
      .flatMap((file) =>
        findOverrideBodies(stripCommentsAndLiterals(readFileSync(file, 'utf8')))
      ).length;
    expect(overrideCount).toBeGreaterThan(0);
  });

  it('never lets an installed plugin answer onRenderProcessGone with anything but false', () => {
    expect(() => {
      for (const plugin of plugins) {
        for (const file of findJavaAndKotlinFiles(plugin.androidSourceDir)) {
          const cleaned = stripCommentsAndLiterals(readFileSync(file, 'utf8'));
          for (const body of findOverrideBodies(cleaned)) {
            assertOverrideAlwaysReturnsFalse(
              `${plugin.name} (${path.relative(plugin.androidSourceDir, file)})`,
              body
            );
          }
        }
      }
    }).not.toThrow();
  });
});
