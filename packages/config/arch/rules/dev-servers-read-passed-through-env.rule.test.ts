import path from 'node:path';
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../lib/source-scope.js';
import rule from './dev-servers-read-passed-through-env.rule.js';

/**
 * The rule reads manifests, the task manifest and dev-server source off the
 * project's file system rather than its parsed source files — the layer's globs
 * select neither a repository-root file nor a package-root config — so every
 * fixture writes real paths under {@link REPO_ROOT} into an in-memory one.
 */
function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  const fileSystem = project.getFileSystem();
  for (const [relative, contents] of Object.entries(files)) {
    fileSystem.writeFileSync(path.join(REPO_ROOT, relative), contents);
  }
  return project;
}

/** A task manifest passing through exactly the given patterns under `dev`. */
function turboWith(passThroughEnv: readonly string[]): string {
  return JSON.stringify({ globalEnv: [], tasks: { dev: { passThroughEnv } } });
}

/** A workspace manifest whose `dev` script is the one given. */
function manifest(name: string, dev: string, extra: Record<string, string> = {}): string {
  return JSON.stringify({ name, scripts: { dev, ...extra } });
}

/** A pattern list as a violation names it. */
function renderPatterns(patterns: readonly string[]): string {
  return patterns.map((pattern) => `\`${pattern}\``).join(', ');
}

/** The violation a key no pattern names produces, for the fixtures that expect one. */
function uncovered(
  key: string,
  patterns: readonly string[] = ['HB_*'],
  workspace = '@hushbox/alpha'
): string {
  return (
    `the \`dev\` server \`${workspace}\` starts reads \`${key}\` from the environment, and ` +
    `the \`dev\` task passes through ${renderPatterns(patterns)}. ` +
    'Turbo runs the task in strict mode, so a variable the list does not name is stripped before ' +
    'the server sees it.'
  );
}

/** The violation an unreadable key expression produces. */
function unresolvedKey(text: string): string {
  return (
    `the \`dev\` server \`@hushbox/alpha\` starts reads the environment under \`${text}\`, ` +
    'which resolves to no key and no static prefix, so nothing here can say whether the `dev` ' +
    'task passes it through.'
  );
}

/** The violation a dev script the rule cannot resolve produces. */
function unrecognised(script: string): string {
  return (
    `\`@hushbox/alpha\` declares \`dev\` as \`${script}\`, a shape this rule cannot resolve ` +
    'to the first-party file it runs, so nothing states what that server reads from the ' +
    'environment.'
  );
}

describe('dev-servers-read-passed-through-env', () => {
  it('flags a key the dev server reads that the pass-through patterns do not name', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/serve.ts': "const token = process.env['ALPHA_TOKEN'];\n",
    });
    expect(rule.check(project)).toEqual([
      {
        file: 'apps/alpha/src/serve.ts',
        line: 1,
        message:
          'the `dev` server `@hushbox/alpha` starts reads `ALPHA_TOKEN` from the environment, ' +
          'and the `dev` task passes through `HB_*`. Turbo runs the task in strict mode, so a ' +
          'variable the list does not name is stripped before the server sees it.',
      },
    ]);
  });

  it('flags a key that was covered until the pattern naming it left the allowlist', () => {
    const source = "const origin = process.env['SANDBOX_ORIGIN_URL'];\n";
    const covered = projectWith({
      'turbo.json': turboWith(['HB_*', 'SANDBOX_ORIGIN_URL']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/serve.ts': source,
    });
    expect(rule.check(covered)).toEqual([]);

    const dropped = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/serve.ts': source,
    });
    expect(rule.check(dropped)).toHaveLength(1);
  });

  it('resolves a key named by a first-party string constant', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/keys.ts': "export const TOKEN_VARIABLE = 'ALPHA_TOKEN';\n",
      'apps/alpha/src/serve.ts': [
        "import { TOKEN_VARIABLE } from './keys.js';",
        '',
        'const token = process.env[TOKEN_VARIABLE];',
        '',
      ].join('\n'),
    });
    expect(rule.check(project)).toEqual([
      {
        file: 'apps/alpha/src/serve.ts',
        line: 3,
        message:
          'the `dev` server `@hushbox/alpha` starts reads `ALPHA_TOKEN` from the environment, ' +
          'and the `dev` task passes through `HB_*`. Turbo runs the task in strict mode, so a ' +
          'variable the list does not name is stripped before the server sees it.',
      },
    ]);
  });

  it('follows an import written with a `.ts` specifier', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/keys.ts': "export const TOKEN_VARIABLE = 'ALPHA_TOKEN';\n",
      'apps/alpha/src/serve.ts': [
        "import { TOKEN_VARIABLE } from './keys.ts';",
        '',
        'const token = process.env[TOKEN_VARIABLE];',
        '',
      ].join('\n'),
    });
    expect(rule.check(project)).toEqual([
      { file: 'apps/alpha/src/serve.ts', line: 3, message: uncovered('ALPHA_TOKEN') },
    ]);
  });

  it('flags an assembled name whose static prefix no pattern covers', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/serve.ts': [
        'function portVariable(service: string): string {',
        '  return `ALPHA_${service}_PORT`;',
        '}',
        '',
        'const port = process.env[portVariable("api")];',
        '',
      ].join('\n'),
    });
    expect(rule.check(project)).toEqual([
      {
        file: 'apps/alpha/src/serve.ts',
        line: 5,
        message:
          'the `dev` server `@hushbox/alpha` starts reads the environment under a name it ' +
          "assembles, and every name it can produce begins `ALPHA_`, which the `dev` task's " +
          'pass-through patterns (`HB_*`) do not cover.',
      },
    ]);
  });

  it('accepts an assembled name whose every product a wildcard covers', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/serve.ts': [
        'function portVariable(service: string): string {',
        '  return `HB_${service}_PORT`;',
        '}',
        '',
        'const port = process.env[portVariable("api")];',
        '',
      ].join('\n'),
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('reads a key through a parameter the entry handed the process environment', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'packages/beta/package.json': JSON.stringify({
        name: '@hushbox/beta',
        exports: { './mode': './src/mode.ts' },
      }),
      'packages/beta/src/mode.ts': [
        'export function modeFrom(env: NodeJS.ProcessEnv): string | undefined {',
        "  return env['ALPHA_MODE'];",
        '}',
        '',
      ].join('\n'),
      'apps/alpha/src/serve.ts': [
        "import { modeFrom } from '@hushbox/beta/mode';",
        '',
        'const mode = modeFrom(process.env);',
        '',
      ].join('\n'),
    });
    expect(rule.check(project)).toEqual([
      {
        file: 'packages/beta/src/mode.ts',
        line: 2,
        message: uncovered('ALPHA_MODE'),
      },
    ]);
  });

  it('reads a key through a parameter whose default is the process environment', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/serve.ts': [
        'function start(env: NodeJS.ProcessEnv = process.env): string | undefined {',
        '  return env.ALPHA_TOKEN;',
        '}',
        '',
        'start();',
        '',
      ].join('\n'),
    });
    expect(rule.check(project)).toEqual([
      { file: 'apps/alpha/src/serve.ts', line: 2, message: uncovered('ALPHA_TOKEN') },
    ]);
  });

  it('resolves a key named by a property of a first-party object constant', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/serve.ts': [
        "const VARIABLES = { token: 'ALPHA_TOKEN' } as const;",
        '',
        'const token = process.env[VARIABLES.token];',
        '',
      ].join('\n'),
    });
    expect(rule.check(project)).toEqual([
      { file: 'apps/alpha/src/serve.ts', line: 3, message: uncovered('ALPHA_TOKEN') },
    ]);
  });

  it('checks both arms of a key chosen by a conditional', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_ALPHA']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/serve.ts': [
        'declare const dev: boolean;',
        "const token = process.env[dev ? 'HB_ALPHA' : 'ALPHA_TOKEN'];",
        '',
      ].join('\n'),
    });
    expect(rule.check(project)).toEqual([
      {
        file: 'apps/alpha/src/serve.ts',
        line: 2,
        message: uncovered('ALPHA_TOKEN', ['HB_ALPHA']),
      },
    ]);
  });

  it('enters a function the entry hands on as a value rather than calling', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/serve.ts': [
        'declare function listen(handler: () => void): void;',
        '',
        'function onRequest(): void {',
        "  void process.env['ALPHA_TOKEN'];",
        '}',
        '',
        'listen(onRequest);',
        '',
      ].join('\n'),
    });
    expect(rule.check(project)).toEqual([
      { file: 'apps/alpha/src/serve.ts', line: 4, message: uncovered('ALPHA_TOKEN') },
    ]);
  });

  it('accepts a key the global environment list names', () => {
    const project = projectWith({
      'turbo.json': JSON.stringify({
        globalEnv: ['DATABASE_URL'],
        tasks: { dev: { passThroughEnv: [] } },
      }),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/serve.ts': "const url = process.env['DATABASE_URL'];\n",
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('reads the pass-through list out of a task manifest carrying comments', () => {
    const project = projectWith({
      'turbo.json': [
        '{',
        '  // The dev servers read these.',
        '  "tasks": { "dev": { "passThroughEnv": ["HB_*"] } }',
        '}',
        '',
      ].join('\n'),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/serve.ts': "const port = process.env['HB_ALPHA_PORT'];\n",
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('follows a wrapper chain to the last file the script executes', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest(
        '@hushbox/alpha',
        'tsx ../../scripts/with-env.ts tsx ../../scripts/serve-alpha.ts'
      ),
      'scripts/package.json': JSON.stringify({ name: '@hushbox/scripts' }),
      'scripts/with-env.ts': "const options = process.env['NODE_OPTIONS'];\n",
      'scripts/serve-alpha.ts': "const token = process.env['ALPHA_TOKEN'];\n",
    });
    expect(rule.check(project)).toEqual([
      { file: 'scripts/serve-alpha.ts', line: 1, message: uncovered('ALPHA_TOKEN') },
    ]);
  });

  it('walks every program a dev script chains, not only the last', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest(
        '@hushbox/alpha',
        'tsx src/first.ts && tsx src/second.ts'
      ),
      'apps/alpha/src/first.ts': "const first = process.env['ALPHA_FIRST'];\n",
      'apps/alpha/src/second.ts': "const second = process.env['ALPHA_SECOND'];\n",
    });
    expect(rule.check(project)).toEqual([
      { file: 'apps/alpha/src/first.ts', line: 1, message: uncovered('ALPHA_FIRST') },
      { file: 'apps/alpha/src/second.ts', line: 1, message: uncovered('ALPHA_SECOND') },
    ]);
  });

  it('reads the runner config of a program chained after another', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/prepare.ts && vite'),
      'apps/alpha/src/prepare.ts': "const prepared = process.env['ALPHA_PREPARE'];\n",
      'apps/alpha/vite.config.ts': "const port = process.env['ALPHA_PORT'];\n",
    });
    expect(rule.check(project)).toEqual([
      { file: 'apps/alpha/src/prepare.ts', line: 1, message: uncovered('ALPHA_PREPARE') },
      { file: 'apps/alpha/vite.config.ts', line: 1, message: uncovered('ALPHA_PORT') },
    ]);
  });

  it('separates chained programs on an operator other than a conjunction', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/first.ts; tsx src/second.ts'),
      'apps/alpha/src/first.ts': "const first = process.env['ALPHA_FIRST'];\n",
      'apps/alpha/src/second.ts': "const second = process.env['ALPHA_SECOND'];\n",
    });
    expect(rule.check(project)).toEqual([
      { file: 'apps/alpha/src/first.ts', line: 1, message: uncovered('ALPHA_FIRST') },
      { file: 'apps/alpha/src/second.ts', line: 1, message: uncovered('ALPHA_SECOND') },
    ]);
  });

  it('reports a chained program it cannot resolve while walking the one it can', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts && caddy run'),
      'apps/alpha/src/serve.ts': "const token = process.env['ALPHA_TOKEN'];\n",
    });
    expect(rule.check(project)).toEqual([
      {
        file: 'apps/alpha/package.json',
        line: 1,
        message: unrecognised('tsx src/serve.ts && caddy run'),
      },
      { file: 'apps/alpha/src/serve.ts', line: 1, message: uncovered('ALPHA_TOKEN') },
    ]);
  });

  it('treats an operator that ends the script as no command at all', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts &'),
      'apps/alpha/src/serve.ts': "const token = process.env['ALPHA_TOKEN'];\n",
    });
    expect(rule.check(project)).toEqual([
      { file: 'apps/alpha/src/serve.ts', line: 1, message: uncovered('ALPHA_TOKEN') },
    ]);
  });

  it('follows a dev script that names another script of the same manifest', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'packages/beta/package.json': manifest('@hushbox/beta', 'pnpm studio', {
        studio: 'tsx src/studio.ts',
      }),
      'packages/beta/src/studio.ts': "const token = process.env['BETA_TOKEN'];\n",
    });
    expect(rule.check(project)).toEqual([
      {
        file: 'packages/beta/src/studio.ts',
        line: 1,
        message: uncovered('BETA_TOKEN', ['HB_*'], '@hushbox/beta'),
      },
    ]);
  });

  it('reads the config file a runner binary evaluates for the package', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'vite'),
      'apps/alpha/vite.config.ts': "const port = process.env['ALPHA_PORT'];\n",
    });
    expect(rule.check(project)).toEqual([
      { file: 'apps/alpha/vite.config.ts', line: 1, message: uncovered('ALPHA_PORT') },
    ]);
  });

  it('reports a dev script it cannot resolve to the file that runs', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'serve-alpha --port 1'),
    });
    expect(rule.check(project)).toEqual([
      {
        file: 'apps/alpha/package.json',
        line: 1,
        message:
          '`@hushbox/alpha` declares `dev` as `serve-alpha --port 1`, a shape this rule cannot ' +
          'resolve to the first-party file it runs, so nothing states what that server reads ' +
          'from the environment.',
      },
    ]);
  });

  it('reports an import the walk needs and cannot resolve to a file', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/serve.ts': [
        "import { modeFrom } from './mode.js';",
        '',
        'const mode = modeFrom(process.env);',
        '',
      ].join('\n'),
    });
    expect(rule.check(project)).toEqual([
      {
        file: 'apps/alpha/src/serve.ts',
        line: 1,
        message:
          'the `dev` server `@hushbox/alpha` starts reaches `./mode.js (modeFrom)`, which ' +
          'resolves to no file in this repository, so the environment keys behind it go unread.',
      },
    ]);
  });

  it('reports a key expression that resolves to neither a name nor a prefix', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/serve.ts': [
        'declare const chosen: string;',
        'const token = process.env[chosen];',
        '',
      ].join('\n'),
    });
    expect(rule.check(project)).toEqual([
      {
        file: 'apps/alpha/src/serve.ts',
        line: 2,
        message:
          'the `dev` server `@hushbox/alpha` starts reads the environment under `chosen`, which ' +
          'resolves to no key and no static prefix, so nothing here can say whether the `dev` ' +
          'task passes it through.',
      },
    ]);
  });

  it('follows a name a module re-exports from another', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/mode.ts': [
        'export function modeFrom(env: NodeJS.ProcessEnv): string | undefined {',
        "  return env['ALPHA_MODE'];",
        '}',
        '',
      ].join('\n'),
      'apps/alpha/src/wrapper.ts': "export { modeFrom } from './mode.js';\n",
      'apps/alpha/src/serve.ts': [
        "import { modeFrom } from './wrapper.js';",
        '',
        'const mode = modeFrom(process.env);',
        '',
      ].join('\n'),
    });
    expect(rule.check(project)).toEqual([
      { file: 'apps/alpha/src/mode.ts', line: 2, message: uncovered('ALPHA_MODE') },
    ]);
  });

  it('stops at an installed dependency rather than reporting it unresolvable', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/serve.ts': [
        "import { config } from 'dotenv';",
        '',
        'config(process.env);',
        '',
      ].join('\n'),
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('passes over a workspace whose manifest declares no dev script', () => {
    const project = projectWith({
      'turbo.json': turboWith([]),
      'packages/beta/package.json': JSON.stringify({
        name: '@hushbox/beta',
        scripts: { build: 'tsc' },
      }),
      'packages/beta/src/index.ts': "const token = process.env['BETA_TOKEN'];\n",
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('refuses to judge anything when the task manifest is gone', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/serve.ts': "const token = process.env['ALPHA_TOKEN'];\n",
    });
    expect(() => rule.check(project)).toThrow(/turbo\.json/);
  });

  it('holds a server to the global list alone when the task declares no environment', () => {
    const project = projectWith({
      'turbo.json': JSON.stringify({ globalEnv: ['NODE_ENV'], tasks: { build: {} } }),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/serve.ts': "const mode = process.env['NODE_ENV'];\n",
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('refuses to judge anything when the task manifest does not parse', () => {
    const project = projectWith({
      'turbo.json': '{ "tasks": ',
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/serve.ts': "const token = process.env['ALPHA_TOKEN'];\n",
    });
    expect(() => rule.check(project)).toThrow(/did not parse/);
  });

  it('reads a config file written as a module rather than TypeScript', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'astro dev'),
      'apps/alpha/astro.config.mjs': "const port = process.env['ALPHA_PORT'];\n",
    });
    expect(rule.check(project)).toEqual([
      { file: 'apps/alpha/astro.config.mjs', line: 1, message: uncovered('ALPHA_PORT') },
    ]);
  });

  it('follows a default import into the module that declares it', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/start.ts': [
        'export default function start(env: NodeJS.ProcessEnv): string | undefined {',
        "  return env['ALPHA_TOKEN'];",
        '}',
        '',
      ].join('\n'),
      'apps/alpha/src/serve.ts': [
        "import './side-effect.js';",
        "import start from './start.js';",
        '',
        'const token = start(process.env);',
        '',
      ].join('\n'),
      'apps/alpha/src/side-effect.ts': 'export const nothing = 1;\n',
    });
    expect(rule.check(project)).toEqual([
      { file: 'apps/alpha/src/start.ts', line: 2, message: uncovered('ALPHA_TOKEN') },
    ]);
  });

  it('enters a function bound to a name rather than declared', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/serve.ts': [
        'const start = function (env: NodeJS.ProcessEnv): string | undefined {',
        '  const read = (): string | undefined => env.ALPHA_TOKEN;',
        '  return read();',
        '};',
        '',
        'start(process.env);',
        '',
      ].join('\n'),
    });
    expect(rule.check(project)).toEqual([
      { file: 'apps/alpha/src/serve.ts', line: 2, message: uncovered('ALPHA_TOKEN') },
    ]);
  });

  it('reads the static prefix off a name a concise arrow assembles', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/serve.ts': [
        'const portVariable = (service: string): string => `ALPHA_${service}`;',
        '',
        'const variable = portVariable("api");',
        'const port = process.env[variable];',
        '',
      ].join('\n'),
    });
    expect(rule.check(project)).toEqual([
      {
        file: 'apps/alpha/src/serve.ts',
        line: 4,
        message:
          'the `dev` server `@hushbox/alpha` starts reads the environment under a name it ' +
          "assembles, and every name it can produce begins `ALPHA_`, which the `dev` task's " +
          'pass-through patterns (`HB_*`) do not cover.',
      },
    ]);
  });

  it('resolves a workspace subpath a package declares no export map for', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'packages/beta/package.json': JSON.stringify({ name: '@hushbox/beta' }),
      'packages/beta/src/mode.ts': [
        'export function modeFrom(env: NodeJS.ProcessEnv): string | undefined {',
        "  return env['ALPHA_MODE'];",
        '}',
        '',
      ].join('\n'),
      'apps/alpha/src/serve.ts': [
        "import { modeFrom } from '@hushbox/beta/mode';",
        '',
        'const mode = modeFrom(process.env);',
        '',
      ].join('\n'),
    });
    expect(rule.check(project)).toEqual([
      { file: 'packages/beta/src/mode.ts', line: 2, message: uncovered('ALPHA_MODE') },
    ]);
  });

  it('reads a key named by a property the object constant quotes', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/serve.ts': [
        "const VARIABLES = { 'token': 'ALPHA_TOKEN' };",
        '',
        'const token = process.env[VARIABLES.token];',
        '',
      ].join('\n'),
    });
    expect(rule.check(project)).toEqual([
      { file: 'apps/alpha/src/serve.ts', line: 3, message: uncovered('ALPHA_TOKEN') },
    ]);
  });

  it('reports a property the object constant it names does not declare', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/serve.ts': [
        "const VARIABLES = { token: 'ALPHA_TOKEN' };",
        '',
        'const other = process.env[VARIABLES.missing];',
        '',
      ].join('\n'),
    });
    expect(rule.check(project)).toEqual([
      { file: 'apps/alpha/src/serve.ts', line: 3, message: unresolvedKey('VARIABLES.missing') },
    ]);
  });

  it('reports a key read off something that is no first-party constant', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/serve.ts': [
        'declare const names: { token: string };',
        'const token = process.env[names.token];',
        '',
      ].join('\n'),
    });
    expect(rule.check(project)).toEqual([
      { file: 'apps/alpha/src/serve.ts', line: 2, message: unresolvedKey('names.token') },
    ]);
  });

  it('reports a key assembled by a call into an installed dependency', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/serve.ts': [
        "import { nameFor } from 'some-package';",
        '',
        'const token = process.env[nameFor()];',
        '',
      ].join('\n'),
    });
    expect(rule.check(project)).toEqual([
      { file: 'apps/alpha/src/serve.ts', line: 3, message: unresolvedKey('nameFor()') },
    ]);
  });

  it('reports a key assembled by a function that hands nothing back', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/serve.ts': [
        'function nameFor(): string {',
        "  throw new Error('no name');",
        '}',
        '',
        'const token = process.env[nameFor()];',
        '',
      ].join('\n'),
    });
    expect(rule.check(project)).toEqual([
      { file: 'apps/alpha/src/serve.ts', line: 5, message: unresolvedKey('nameFor()') },
    ]);
  });

  it('reports a name assembled with no static prefix at all', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/serve.ts': [
        'declare const service: string;',
        'const port = process.env[`${service}_PORT`];',
        '',
      ].join('\n'),
    });
    expect(rule.check(project)).toEqual([
      { file: 'apps/alpha/src/serve.ts', line: 2, message: unresolvedKey('`${service}_PORT`') },
    ]);
  });

  it('reads a key written as a template with nothing substituted into it', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/serve.ts': 'const token = process.env[`ALPHA_TOKEN`];\n',
    });
    expect(rule.check(project)).toEqual([
      { file: 'apps/alpha/src/serve.ts', line: 1, message: uncovered('ALPHA_TOKEN') },
    ]);
  });

  it('names a workspace by its directory when its manifest declares no name', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': JSON.stringify({ scripts: { dev: 'tsx src/serve.ts' } }),
      'apps/alpha/src/serve.ts': "const token = process.env['ALPHA_TOKEN'];\n",
    });
    expect(rule.check(project)).toEqual([
      {
        file: 'apps/alpha/src/serve.ts',
        line: 1,
        message: uncovered('ALPHA_TOKEN', ['HB_*'], 'apps/alpha'),
      },
    ]);
  });

  it('reads a key passed to a member call the walk does not follow', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/serve.ts': [
        'declare const server: { listen: (token: string | undefined) => void };',
        "server.listen(process.env['ALPHA_TOKEN']);",
        '',
      ].join('\n'),
    });
    expect(rule.check(project)).toEqual([
      { file: 'apps/alpha/src/serve.ts', line: 2, message: uncovered('ALPHA_TOKEN') },
    ]);
  });

  it('reports one violation for a frame two identical calls reach', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/serve.ts': [
        'function read(env: NodeJS.ProcessEnv): string | undefined {',
        "  return env['ALPHA_TOKEN'];",
        '}',
        '',
        'read(process.env);',
        'read(process.env);',
        '',
      ].join('\n'),
    });
    expect(rule.check(project)).toEqual([
      { file: 'apps/alpha/src/serve.ts', line: 2, message: uncovered('ALPHA_TOKEN') },
    ]);
  });

  it('gives up on a name two modules re-export to each other', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/one.ts': "export { modeFrom } from './two.js';\n",
      'apps/alpha/src/two.ts': "export { modeFrom } from './one.js';\n",
      'apps/alpha/src/serve.ts': [
        "import { modeFrom } from './one.js';",
        '',
        'const mode = modeFrom(process.env);',
        '',
      ].join('\n'),
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('gives up on a key two module constants name each other through', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/serve.ts': [
        'declare const seed: string;',
        'const FIRST = SECOND;',
        'const SECOND = FIRST;',
        'const token = process.env[FIRST];',
        '',
      ].join('\n'),
    });
    const violations = rule.check(project);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('resolves to no key and no static prefix');
  });

  it('follows a default export that hands on a name declared beside it', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/start.ts': [
        'function start(env: NodeJS.ProcessEnv): string | undefined {',
        "  return env['ALPHA_TOKEN'];",
        '}',
        '',
        'export default start;',
        '',
      ].join('\n'),
      'apps/alpha/src/serve.ts': [
        "import start from './start.js';",
        '',
        'const token = start(process.env);',
        '',
      ].join('\n'),
    });
    expect(rule.check(project)).toEqual([
      { file: 'apps/alpha/src/start.ts', line: 2, message: uncovered('ALPHA_TOKEN') },
    ]);
  });

  it('stops at a default import the module it names never declares', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/start.ts': 'export const other = 1;\n',
      'apps/alpha/src/serve.ts': [
        "import start from './start.js';",
        '',
        'const token = start(process.env);',
        '',
      ].join('\n'),
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('reports a key written as an expression the walk reads no name out of', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/serve.ts': "const token = process.env['ALPHA' + '_TOKEN'];\n",
    });
    expect(rule.check(project)).toEqual([
      { file: 'apps/alpha/src/serve.ts', line: 1, message: unresolvedKey("'ALPHA' + '_TOKEN'") },
    ]);
  });

  it('reads both keys a frame holding two environments apiece is given', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/serve.ts': [
        'function read(first: NodeJS.ProcessEnv, second: NodeJS.ProcessEnv): string {',
        "  return `${String(first['ALPHA_ONE'])}${String(second['ALPHA_TWO'])}`;",
        '}',
        '',
        'read(process.env, process.env);',
        '',
      ].join('\n'),
    });
    expect(rule.check(project)).toEqual([
      { file: 'apps/alpha/src/serve.ts', line: 2, message: uncovered('ALPHA_ONE') },
      { file: 'apps/alpha/src/serve.ts', line: 2, message: uncovered('ALPHA_TWO') },
    ]);
  });

  it('reports a dev script that names no other script to run', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'pnpm'),
    });
    expect(rule.check(project)).toEqual([
      { file: 'apps/alpha/package.json', line: 1, message: unrecognised('pnpm') },
    ]);
  });

  it('reports a dev script that names itself', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'pnpm dev'),
    });
    expect(rule.check(project)).toEqual([
      { file: 'apps/alpha/package.json', line: 1, message: unrecognised('pnpm dev') },
    ]);
  });

  it('resolves a workspace package named with no subpath at all', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'packages/beta/package.json': JSON.stringify({ name: '@hushbox/beta' }),
      'packages/beta/src/index.ts': [
        'export function modeFrom(env: NodeJS.ProcessEnv): string | undefined {',
        "  return env['ALPHA_MODE'];",
        '}',
        '',
      ].join('\n'),
      'apps/alpha/src/serve.ts': [
        "import { modeFrom } from '@hushbox/beta';",
        '',
        'const mode = modeFrom(process.env);',
        '',
      ].join('\n'),
    });
    expect(rule.check(project)).toEqual([
      { file: 'packages/beta/src/index.ts', line: 2, message: uncovered('ALPHA_MODE') },
    ]);
  });

  it('follows a default export written with no name of its own', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/start.ts': [
        'export default function (env: NodeJS.ProcessEnv): string | undefined {',
        "  return env['ALPHA_TOKEN'];",
        '}',
        '',
      ].join('\n'),
      'apps/alpha/src/serve.ts': [
        "import start from './start.js';",
        '',
        'const token = start(process.env);',
        '',
      ].join('\n'),
    });
    expect(rule.check(project)).toEqual([
      { file: 'apps/alpha/src/start.ts', line: 2, message: uncovered('ALPHA_TOKEN') },
    ]);
  });

  it('reads a name off the assembling function itself, not a function inside it', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/serve.ts': [
        'function nameFor(service: string): string {',
        '  const suffix = (): string => {',
        "    return '_PORT';",
        '  };',
        '  return `ALPHA_${service}${suffix()}`;',
        '}',
        '',
        'const port = process.env[nameFor("api")];',
        '',
      ].join('\n'),
    });
    expect(rule.check(project)).toEqual([
      {
        file: 'apps/alpha/src/serve.ts',
        line: 8,
        message:
          'the `dev` server `@hushbox/alpha` starts reads the environment under a name it ' +
          "assembles, and every name it can produce begins `ALPHA_`, which the `dev` task's " +
          'pass-through patterns (`HB_*`) do not cover.',
      },
    ]);
  });

  it('reports a dev script with no command in it at all', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', '  '),
    });
    expect(rule.check(project)).toEqual([
      { file: 'apps/alpha/package.json', line: 1, message: unrecognised('  ') },
    ]);
  });

  it('reads a key past a parameter taken apart rather than named', () => {
    const project = projectWith({
      'turbo.json': turboWith(['HB_*']),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/serve.ts': [
        'function start({ quiet }: { quiet: boolean }): string | undefined {',
        "  return quiet ? undefined : process.env['ALPHA_TOKEN'];",
        '}',
        '',
        'start({ quiet: false });',
        '',
      ].join('\n'),
    });
    expect(rule.check(project)).toEqual([
      { file: 'apps/alpha/src/serve.ts', line: 2, message: uncovered('ALPHA_TOKEN') },
    ]);
  });

  it('holds a server to nothing when the task manifest declares no tasks', () => {
    const project = projectWith({
      'turbo.json': JSON.stringify({ globalEnv: ['NODE_ENV'] }),
      'apps/alpha/package.json': manifest('@hushbox/alpha', 'tsx src/serve.ts'),
      'apps/alpha/src/serve.ts': "const token = process.env['ALPHA_TOKEN'];\n",
    });
    expect(rule.check(project)).toEqual([
      { file: 'apps/alpha/src/serve.ts', line: 1, message: uncovered('ALPHA_TOKEN', ['NODE_ENV']) },
    ]);
  });
});
