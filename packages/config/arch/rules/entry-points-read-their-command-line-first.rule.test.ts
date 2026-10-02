import { Project, ts } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './entry-points-read-their-command-line-first.rule.js';

/**
 * The shared command-line plumbing every entry point in `scripts/` is wired
 * through, small but shaped like the real thing: the grammar module the rule
 * recognises a read by, the main-module test the guard is written with, and the
 * error-handling wrapper most guards hand their body to.
 *
 * Beside them sit the two modules of that same tree that shell out to git.
 * They are here because sharing an address with the plumbing is what an
 * exemption by location would have rewarded, and neither is plumbing: an entry
 * calling one before its read has acted.
 */
const CLI_LIBRARY: Readonly<Record<string, string>> = {
  'scripts/lib/cli/command-line.ts':
    'export interface CommandSpec {\n' +
    '  readonly command: string;\n' +
    '  readonly summary: string;\n' +
    '  readonly flags: readonly { readonly flag: string }[];\n' +
    '  readonly positionals: { readonly kind: string };\n' +
    '}\n' +
    'export function readCommandLine(spec: CommandSpec, argv: readonly string[]): unknown {\n' +
    '  return [spec, argv];\n' +
    '}\n' +
    'export function parseCommandLine(spec: CommandSpec, argv: readonly string[]): unknown {\n' +
    '  return [spec, argv];\n' +
    '}\n' +
    'export function isHelpRequest(argv: readonly string[]): boolean {\n' +
    '  return argv.length > 0;\n' +
    '}\n' +
    'export function formatUsage(spec: CommandSpec): string {\n' +
    '  return spec.command;\n' +
    '}\n',
  'scripts/lib/cli/is-main.ts':
    'export function isMainModule(url: string): boolean {\n  return url.length > 0;\n}\n',
  'scripts/lib/cli/run-main.ts':
    'export function runMain(action: () => unknown): void {\n  void action();\n}\n',
  'scripts/lib/cli/git-checkout.ts':
    'export function resolveGitCommonDir(dir: string): string {\n  return dir;\n}\n',
  'scripts/lib/cli/pushed-range.ts':
    'export function advertisedObjectIds(remote: string): string[] {\n  return [remote];\n}\n',
};

/** A spec literal, written the way an entry point writes one. */
const SPEC_LITERAL =
  'export const COMMAND_LINE = {\n' +
  "  command: 'pnpm thing',\n" +
  "  summary: 'Does the thing.',\n" +
  '  flags: [],\n' +
  "  positionals: { kind: 'none' },\n" +
  '} as const satisfies CommandSpec;\n';

const IMPORTS =
  "import { isMainModule } from './lib/cli/is-main.js';\n" +
  "import { readCommandLine, type CommandSpec } from './lib/cli/command-line.js';\n" +
  "import { runMain } from './lib/cli/run-main.js';\n" +
  "import { reclaimPorts } from './reclaim.js';\n";

const ACTING_MODULE = 'scripts/reclaim.ts';

const ENTRY = 'scripts/thing.ts';

function projectWith(files: Readonly<Record<string, string>>): Project {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noLib: true,
      baseUrl: '/',
    },
  });
  for (const [filePath, source] of Object.entries({
    ...CLI_LIBRARY,
    [ACTING_MODULE]: 'export function reclaimPorts(): number {\n  return 0;\n}\n',
    ...files,
  })) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

/** One entry-point module, with the given guard body. */
function entryWith(guard: string, spec = SPEC_LITERAL): Readonly<Record<string, string>> {
  return { [ENTRY]: `${IMPORTS}\n${spec}\n${guard}` };
}

describe('entry-points-read-their-command-line-first', () => {
  describe('the mis-wiring it refuses', () => {
    it('flags a guard that acts before it reads the specification', () => {
      const violations = rule.check(
        projectWith(
          entryWith(
            'if (isMainModule(import.meta.url)) {\n' +
              '  runMain(() => {\n' +
              '    reclaimPorts();\n' +
              '    return readCommandLine(COMMAND_LINE, process.argv.slice(2));\n' +
              '  });\n' +
              '}\n'
          )
        )
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: ENTRY });
      expect(violations[0]?.message).toContain('reclaimPorts');
    });

    it('flags a guard that constructs before it reads the specification', () => {
      const violations = rule.check(
        projectWith(
          entryWith(
            'class Client {}\n' +
              'if (isMainModule(import.meta.url)) {\n' +
              '  runMain(() => {\n' +
              '    const client = new Client();\n' +
              '    return readCommandLine(COMMAND_LINE, process.argv.slice(2)) ?? client;\n' +
              '  });\n' +
              '}\n'
          )
        )
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('Client');
    });

    it('flags an entry point that declares a specification and never reads it', () => {
      const violations = rule.check(
        projectWith(
          entryWith('if (isMainModule(import.meta.url)) {\n  runMain(() => reclaimPorts());\n}\n')
        )
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('COMMAND_LINE');
    });

    it('flags a guard that reads nothing at all, however inert it looks', () => {
      const violations = rule.check(
        projectWith(
          entryWith(
            'if (isMainModule(import.meta.url)) {\n' +
              '  const argv = process.argv.slice(2);\n' +
              '  void argv;\n' +
              '}\n'
          )
        )
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('never');
    });

    it('flags a guard whose read passes a specification other than its own', () => {
      const violations = rule.check(
        projectWith({
          'scripts/other-spec.ts':
            "import type { CommandSpec } from './lib/cli/command-line.js';\n" +
            'export const OTHER = {\n' +
            "  command: 'pnpm other',\n" +
            "  summary: 'Other.',\n" +
            '  flags: [],\n' +
            "  positionals: { kind: 'none' },\n" +
            '} as const satisfies CommandSpec;\n',
          [ENTRY]:
            `${IMPORTS}import { OTHER } from './other-spec.js';\n\n${SPEC_LITERAL}\n` +
            'if (isMainModule(import.meta.url)) {\n' +
            '  runMain(() => {\n' +
            '    readCommandLine(OTHER, process.argv.slice(2));\n' +
            '    return reclaimPorts();\n' +
            '  });\n' +
            '}\n',
        })
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('COMMAND_LINE');
    });

    it('flags a guard whose read names something the compiler cannot resolve', () => {
      const violations = rule.check(
        projectWith(
          entryWith(
            'if (isMainModule(import.meta.url)) {\n' +
              '  runMain(() => readCommandLine(MISSING_GRAMMAR, process.argv.slice(2)));\n' +
              '}\n'
          )
        )
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('never');
    });

    it('flags a guard calling through a callee with no name at its root', () => {
      const violations = rule.check(
        projectWith(
          entryWith(
            'if (isMainModule(import.meta.url)) {\n' +
              '  runMain(() => {\n' +
              '    (0, reclaimPorts)();\n' +
              '    return readCommandLine(COMMAND_LINE, process.argv.slice(2));\n' +
              '  });\n' +
              '}\n'
          )
        )
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('reclaimPorts');
    });

    it('flags a guard whose local frame is not a function at all', () => {
      const violations = rule.check(
        projectWith(
          entryWith(
            'class Runner {}\n' +
              'if (isMainModule(import.meta.url)) {\n' +
              '  runMain(() => Runner());\n' +
              '}\n'
          )
        )
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('never');
    });

    it.each([
      { module: 'git-checkout', symbol: 'resolveGitCommonDir' },
      { module: 'pushed-range', symbol: 'advertisedObjectIds' },
    ])(
      'flags a guard that calls $symbol before its read, plumbing tree or not',
      ({ module, symbol }) => {
        const violations = rule.check(
          projectWith({
            [ENTRY]:
              `${IMPORTS}import { ${symbol} } from './lib/cli/${module}.js';\n\n${SPEC_LITERAL}\n` +
              'if (isMainModule(import.meta.url)) {\n' +
              '  runMain(() => {\n' +
              `    ${symbol}(process.cwd());\n` +
              '    return readCommandLine(COMMAND_LINE, process.argv.slice(2));\n' +
              '  });\n' +
              '}\n',
          })
        );

        expect(violations).toHaveLength(1);
        expect(violations[0]?.message).toContain(symbol);
      }
    );

    it('flags a guard that hands the wrapper a function from another module', () => {
      const violations = rule.check(
        projectWith(
          entryWith('if (isMainModule(import.meta.url)) {\n  runMain(reclaimPorts);\n}\n')
        )
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('never');
    });
  });

  describe('the wiring it accepts', () => {
    it('passes an entry point whose other exports are not specifications', () => {
      expect(
        rule.check(
          projectWith(
            entryWith(
              'export function helper(): number {\n  return 1;\n}\n' +
                "export const NAME = 'thing';\n" +
                'if (isMainModule(import.meta.url)) {\n' +
                '  runMain(() => readCommandLine(COMMAND_LINE, process.argv.slice(2)));\n' +
                '}\n'
            )
          )
        )
      ).toEqual([]);
    });

    it('passes a read whose specification is written through a type assertion', () => {
      expect(
        rule.check(
          projectWith(
            entryWith(
              'if (isMainModule(import.meta.url)) {\n' +
                '  runMain(() =>\n' +
                '    readCommandLine(COMMAND_LINE as CommandSpec, process.argv.slice(2))\n' +
                '  );\n' +
                '}\n'
            )
          )
        )
      ).toEqual([]);
    });

    it('passes a read handed straight to something that acts on it', () => {
      expect(
        rule.check(
          projectWith(
            entryWith(
              'if (isMainModule(import.meta.url)) {\n' +
                '  runMain(() => report(readCommandLine(COMMAND_LINE, process.argv.slice(2))));\n' +
                '}\n' +
                'function report(parsed: unknown): unknown {\n  return parsed;\n}\n'
            )
          )
        )
      ).toEqual([]);
    });

    it('passes a guard gated on a bare name the main-module test was bound to', () => {
      expect(
        rule.check(
          projectWith(
            entryWith(
              'const isMain = isMainModule(import.meta.url);\n' +
                'if (isMain) {\n' +
                '  runMain(() => readCommandLine(COMMAND_LINE, process.argv.slice(2)));\n' +
                '}\n'
            )
          )
        )
      ).toEqual([]);
    });

    it('passes a guard whose condition tests the main module twice', () => {
      expect(
        rule.check(
          projectWith(
            entryWith(
              'if (isMainModule(import.meta.url) || isMainModule(import.meta.url)) {\n' +
                '  runMain(() => readCommandLine(COMMAND_LINE, process.argv.slice(2)));\n' +
                '}\n'
            )
          )
        )
      ).toEqual([]);
    });

    it('passes a module that tests the main module outside any guard', () => {
      expect(rule.check(projectWith(entryWith('void isMainModule(import.meta.url);\n')))).toEqual(
        []
      );
    });

    it('passes a guard reading its specification before anything else', () => {
      expect(
        rule.check(
          projectWith(
            entryWith(
              'if (isMainModule(import.meta.url)) {\n' +
                '  runMain(() => {\n' +
                '    const parsed = readCommandLine(COMMAND_LINE, process.argv.slice(2));\n' +
                '    if (parsed === null) return 0;\n' +
                '    return reclaimPorts();\n' +
                '  });\n' +
                '}\n'
            )
          )
        )
      ).toEqual([]);
    });

    it('passes a guard whose read sits in the guard condition itself', () => {
      expect(
        rule.check(
          projectWith(
            entryWith(
              'const isMain = isMainModule(import.meta.url);\n' +
                'if (isMain && readCommandLine(COMMAND_LINE, process.argv.slice(2)) !== null)\n' +
                '  reclaimPorts();\n'
            )
          )
        )
      ).toEqual([]);
    });

    it('passes a guard that reaches its read through a function of its own module', () => {
      expect(
        rule.check(
          projectWith(
            entryWith(
              'function parseArgs(argv: readonly string[]): unknown {\n' +
                '  return readCommandLine(COMMAND_LINE, argv);\n' +
                '}\n' +
                'async function main(argv: readonly string[]): Promise<number> {\n' +
                '  if (parseArgs(argv) === null) return 0;\n' +
                '  return reclaimPorts();\n' +
                '}\n' +
                'if (isMainModule(import.meta.url)) {\n' +
                '  void (async () => {\n' +
                '    await main(process.argv.slice(2));\n' +
                '  })();\n' +
                '}\n'
            )
          )
        )
      ).toEqual([]);
    });

    it('passes a guard that hands the wrapper a function of its own by name', () => {
      expect(
        rule.check(
          projectWith(
            entryWith(
              'async function main(): Promise<number> {\n' +
                '  if (readCommandLine(COMMAND_LINE, process.argv.slice(2)) === null) return 0;\n' +
                '  return reclaimPorts();\n' +
                '}\n' +
                'if (isMainModule(import.meta.url)) {\n  runMain(main);\n}\n'
            )
          )
        )
      ).toEqual([]);
    });

    it('passes a guard whose frame is a const arrow rather than a declaration', () => {
      expect(
        rule.check(
          projectWith(
            entryWith(
              'const main = (): unknown => readCommandLine(COMMAND_LINE, process.argv.slice(2));\n' +
                'if (isMainModule(import.meta.url)) {\n  runMain(main);\n}\n'
            )
          )
        )
      ).toEqual([]);
    });

    it('reports a mutually recursive pair once rather than walking it forever', () => {
      const violations = rule.check(
        projectWith(
          entryWith(
            'function ping(depth: number): number {\n' +
              '  return depth > 0 ? pong(depth - 1) : reclaimPorts();\n' +
              '}\n' +
              'function pong(depth: number): number {\n  return ping(depth);\n}\n' +
              'if (isMainModule(import.meta.url)) {\n  runMain(() => ping(3));\n}\n'
          )
        )
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('ping');
    });

    it('passes a guard that computes paths from its own location before reading', () => {
      expect(
        rule.check(
          projectWith(
            entryWith(
              "import path from 'node:path';\n" +
                "import { fileURLToPath } from 'node:url';\n" +
                'if (isMainModule(import.meta.url)) {\n' +
                '  runMain(() => {\n' +
                '    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));\n' +
                '    if (readCommandLine(COMMAND_LINE, process.argv.slice(2)) === null) return 0;\n' +
                '    return reclaimPorts() + root.length;\n' +
                '  });\n' +
                '}\n'
            )
          )
        )
      ).toEqual([]);
    });

    it('passes a guard that builds deferred callbacks it never invokes before reading', () => {
      expect(
        rule.check(
          projectWith(
            entryWith(
              'if (isMainModule(import.meta.url)) {\n' +
                '  runMain(() => {\n' +
                '    const deps = { reclaim: () => reclaimPorts() };\n' +
                '    if (readCommandLine(COMMAND_LINE, process.argv.slice(2)) === null) return 0;\n' +
                '    return deps.reclaim();\n' +
                '  });\n' +
                '}\n'
            )
          )
        )
      ).toEqual([]);
    });

    it('passes a module that owns a main guard and declares no specification', () => {
      expect(
        rule.check(
          projectWith({
            [ENTRY]:
              "import { isMainModule } from './lib/cli/is-main.js';\n" +
              "import { reclaimPorts } from './reclaim.js';\n" +
              'if (isMainModule(import.meta.url)) {\n  reclaimPorts();\n}\n',
          })
        )
      ).toEqual([]);
    });

    it('passes a module that declares a specification and owns no main guard', () => {
      expect(
        rule.check(
          projectWith({
            'scripts/lib/spec-only.ts':
              "import type { CommandSpec } from '../lib/cli/command-line.js';\n" + SPEC_LITERAL,
          })
        )
      ).toEqual([]);
    });

    it('passes a test file that mis-wires a guard, since no developer types it', () => {
      expect(
        rule.check(
          projectWith({
            'scripts/thing.test.ts':
              `${IMPORTS}\n${SPEC_LITERAL}\n` +
              'if (isMainModule(import.meta.url)) {\n  reclaimPorts();\n}\n',
          })
        )
      ).toEqual([]);
    });

    it('passes a mis-wired guard outside the scripts workspace', () => {
      expect(
        rule.check(
          projectWith({
            'apps/api/src/thing.ts':
              "import { isMainModule } from './lib/cli/is-main.js';\n" +
              "import { readCommandLine, type CommandSpec } from './lib/cli/command-line.js';\n" +
              "import { reclaimPorts } from './reclaim.js';\n" +
              SPEC_LITERAL +
              'if (isMainModule(import.meta.url)) {\n' +
              '  reclaimPorts();\n' +
              '  readCommandLine(COMMAND_LINE, process.argv.slice(2));\n' +
              '}\n',
          })
        )
      ).toEqual([]);
    });
  });

  describe('the specification a text search cannot bind to its entry point', () => {
    /**
     * The shape that defeats every text search over the tree: the literal lives
     * in a module that is not an entry point and carries a name no convention
     * predicts, and the entry point holds only an alias of it. A search for the
     * literal names the wrong module, a search for the standard name beside a
     * literal names neither, and a search for the bare name names an entry
     * whose specification is not in it.
     */
    const DECLARING_MODULE = 'scripts/lib/stack/daemon.ts';
    const ALIASING_ENTRY = 'scripts/lib/stack/daemon-entry.ts';

    const DECLARING_SOURCE =
      "import type { CommandSpec } from '../cli/command-line.js';\n" +
      'export const DAEMON_GRAMMAR = {\n' +
      "  command: 'tsx scripts/lib/stack/daemon-entry.ts',\n" +
      "  summary: 'Tears the stack down.',\n" +
      '  flags: [],\n' +
      "  positionals: { kind: 'none' },\n" +
      '} as const satisfies CommandSpec;\n' +
      'export function tearDown(): number {\n  return 0;\n}\n';

    function aliasingEntry(guard: string): Readonly<Record<string, string>> {
      return {
        [DECLARING_MODULE]: DECLARING_SOURCE,
        [ALIASING_ENTRY]:
          "import { isMainModule } from '../cli/is-main.js';\n" +
          "import { readCommandLine } from '../cli/command-line.js';\n" +
          "import { DAEMON_GRAMMAR, tearDown } from './daemon.js';\n" +
          'export const COMMAND_LINE = DAEMON_GRAMMAR;\n' +
          guard,
      };
    }

    it('flags the aliasing entry point when it acts before it reads', () => {
      const violations = rule.check(
        projectWith(
          aliasingEntry(
            'if (isMainModule(import.meta.url)) {\n' +
              '  tearDown();\n' +
              '  readCommandLine(COMMAND_LINE, process.argv.slice(2));\n' +
              '}\n'
          )
        )
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: ALIASING_ENTRY });
      expect(violations[0]?.message).toContain('tearDown');
    });

    it('flags the aliasing entry point when it never reads the specification it re-exports', () => {
      const violations = rule.check(
        projectWith(aliasingEntry('if (isMainModule(import.meta.url)) {\n  tearDown();\n}\n'))
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: ALIASING_ENTRY });
    });

    it('passes the aliasing entry point when it reads the alias first', () => {
      expect(
        rule.check(
          projectWith(
            aliasingEntry(
              'if (isMainModule(import.meta.url)) {\n' +
                '  if (readCommandLine(COMMAND_LINE, process.argv.slice(2)) !== null) tearDown();\n' +
                '}\n'
            )
          )
        )
      ).toEqual([]);
    });

    it('leaves the declaring module alone, since nobody types it', () => {
      expect(
        rule.check(
          projectWith({
            [DECLARING_MODULE]: DECLARING_SOURCE,
          })
        )
      ).toEqual([]);
    });
  });
});
