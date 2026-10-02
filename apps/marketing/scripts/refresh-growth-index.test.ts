import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Destination, Mode, getDestinations, secret } from '@hushbox/shared';
import { envConfig } from '@hushbox/shared/env.config';
import { GROWTH_INIT_SCRIPT } from '@hushbox/ui/growth/init-script';
import {
  dropBakedVariables,
  placeholderProductionEnv,
  refreshGrowthIndex,
  siteBuildOptions,
  siteConfigModule,
} from './refresh-growth-index';
import type { VariableConfig } from '@hushbox/shared';
import type { SiteBuild } from './refresh-growth-index';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'growth-index-refresh-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const scratchParent = (): string => path.join(root, 'scratch');
const indexFile = (): string => path.join(root, 'index', 'growth-index.json');

/** A built page carrying the beacon and a client module built under production. */
function writeProductionPage(outDir: string, relative: string, body: string): void {
  const module = path.join(outDir, '_astro', 'env.js');
  mkdirSync(path.dirname(module), { recursive: true });
  writeFileSync(module, 'var z=c({NODE_ENV:`production`});export{z};');
  const page = path.join(outDir, relative);
  mkdirSync(path.dirname(page), { recursive: true });
  writeFileSync(
    page,
    `<!DOCTYPE html><html><body>${body}<script>${GROWTH_INIT_SCRIPT}</script><script type="module" src="/_astro/env.js"></script></body></html>`
  );
}

/** Lines of a generated env file as a key-to-raw-value map. */
function envLines(content: string): Record<string, string> {
  return Object.fromEntries(
    content
      .split('\n')
      .filter((line) => /^[A-Z]/u.test(line))
      .map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at), line.slice(at + 1)];
      })
  );
}

describe('refreshGrowthIndex', () => {
  it('writes no index when the site build fails after emitting pages', async () => {
    const failing = (site: SiteBuild): Promise<void> => {
      writeProductionPage(site.outDir, 'welcome/index.html', '<a href="/signup">Start</a>');
      return Promise.reject(new Error('the build stopped part way'));
    };

    await expect(
      refreshGrowthIndex({ scratchParent: scratchParent(), indexFile: indexFile(), build: failing })
    ).rejects.toThrow('the build stopped part way');

    expect(existsSync(indexFile())).toBe(false);
  });

  it('writes the index the built site yields when the build succeeds', async () => {
    const succeeding = (site: SiteBuild): Promise<void> => {
      writeProductionPage(site.outDir, 'welcome/index.html', '<a href="/signup">Start</a>');
      return Promise.resolve();
    };

    await refreshGrowthIndex({
      scratchParent: scratchParent(),
      indexFile: indexFile(),
      build: succeeding,
    });

    const index = z
      .record(z.string(), z.array(z.string()))
      .parse(JSON.parse(readFileSync(indexFile(), 'utf8')));
    expect(index['/welcome']).toContain('link:/signup');
  });

  it('builds into a directory under the scratch parent it is given', async () => {
    let outDir = '';
    await refreshGrowthIndex({
      scratchParent: scratchParent(),
      indexFile: indexFile(),
      build: (site: SiteBuild): Promise<void> => {
        outDir = site.outDir;
        writeProductionPage(site.outDir, 'welcome/index.html', '');
        return Promise.resolve();
      },
    });

    expect(path.relative(scratchParent(), outDir).startsWith('..')).toBe(false);
  });

  it('hands the build a production env file with every placeholder in place', async () => {
    let handed = '';
    await refreshGrowthIndex({
      scratchParent: scratchParent(),
      indexFile: indexFile(),
      build: (site: SiteBuild): Promise<void> => {
        handed = readFileSync(path.join(site.envDir, '.env.production'), 'utf8');
        writeProductionPage(site.outDir, 'welcome/index.html', '');
        return Promise.resolve();
      },
    });

    expect(handed).toBe(placeholderProductionEnv(envConfig));
  });

  it('hands the build a configuration that writes into its output directory', async () => {
    let configuration = '';
    let outDir = '';
    await refreshGrowthIndex({
      scratchParent: scratchParent(),
      indexFile: indexFile(),
      build: (site: SiteBuild): Promise<void> => {
        configuration = readFileSync(site.configFile, 'utf8');
        outDir = site.outDir;
        writeProductionPage(site.outDir, 'welcome/index.html', '');
        return Promise.resolve();
      },
    });

    expect(configuration).toContain(`outDir: ${JSON.stringify(outDir)}`);
  });

  it('removes its scratch directory when the build succeeds', async () => {
    await refreshGrowthIndex({
      scratchParent: scratchParent(),
      indexFile: indexFile(),
      build: (site: SiteBuild): Promise<void> => {
        writeProductionPage(site.outDir, 'welcome/index.html', '');
        return Promise.resolve();
      },
    });

    expect(readdirOf(scratchParent())).toEqual([]);
  });

  it('removes its scratch directory when the build fails', async () => {
    await expect(
      refreshGrowthIndex({
        scratchParent: scratchParent(),
        indexFile: indexFile(),
        build: (): Promise<void> => Promise.reject(new Error('no site')),
      })
    ).rejects.toThrow('no site');

    expect(readdirOf(scratchParent())).toEqual([]);
  });
});

/** The entries of a directory, or none where it was never made. */
function readdirOf(directory: string): string[] {
  return existsSync(directory) ? readdirSync(directory) : [];
}

describe('placeholderProductionEnv', () => {
  const production = envLines(placeholderProductionEnv(envConfig));

  it('writes every variable the production frontend file carries', () => {
    const frontend = Object.entries(envConfig)
      .filter(([, config]) =>
        getDestinations(config as VariableConfig, Mode.Production).includes(Destination.Frontend)
      )
      .map(([key]) => key);
    const byName = (left: string, right: string): number => left.localeCompare(right);
    expect(Object.keys(production).toSorted(byName)).toEqual(frontend.toSorted(byName));
  });

  it('keeps a literal production value as the registry states it', () => {
    expect(production['VITE_API_URL']).toBe('"https://api.hushbox.ai"');
  });

  it('stands a secret-typed value in with its development value', () => {
    expect(production['VITE_APP_VERSION']).toBe('"dev-local"');
  });

  it('refuses a secret-typed value whose development value is no literal', () => {
    const registry: Record<string, VariableConfig> = {
      VITE_UNBACKED: {
        to: [Destination.Frontend],
        [Mode.Development]: secret('VITE_UNBACKED_DEVELOPMENT'),
        [Mode.Production]: secret('VITE_UNBACKED'),
      },
    };
    expect(() => placeholderProductionEnv(registry)).toThrow(/VITE_UNBACKED/u);
  });
});

describe('siteConfigModule', () => {
  /** Writes a stand-in for the package configuration and the env-file guard module. */
  function writeStandIns(): { packageConfig: string; buildModeModule: string } {
    const packageConfig = path.join(root, 'package-config.mjs');
    writeFileSync(
      packageConfig,
      `export default { site: 'https://hushbox.ai', outDir: 'dist', vite: { envDir: '../..', strictPort: true, plugins: [{ name: 'frontend-env-file', rootDir: 'repo' }, { name: 'tailwind' }, [{ name: 'nested' }]] } };`
    );
    const buildModeModule = path.join(root, 'build-mode.mjs');
    writeFileSync(
      buildModeModule,
      `export function frontendEnvFilePlugin(rootDir) { return { name: 'frontend-env-file', rootDir }; }`
    );
    return { packageConfig, buildModeModule };
  }

  /** Writes the generated module and imports what it exports. */
  function generated(): z.infer<typeof GENERATED> {
    const configFile = path.join(root, 'site.config.mjs');
    writeFileSync(
      configFile,
      siteConfigModule({
        ...writeStandIns(),
        outDir: path.join(root, 'out'),
        envDir: path.join(root, 'env'),
      })
    );
    // Evaluated by Node itself rather than the test runner's module loader,
    // which resolves no module outside the workspace.
    const printed = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `const site = await import(${JSON.stringify(pathToFileURL(configFile).href)}); process.stdout.write(JSON.stringify(site.default));`,
      ],
      { encoding: 'utf8' }
    );
    return GENERATED.parse(JSON.parse(printed));
  }

  const GENERATED = z.object({
    site: z.string(),
    outDir: z.string(),
    vite: z.object({
      envDir: z.string(),
      strictPort: z.boolean(),
      plugins: z.array(z.unknown()),
    }),
  });

  it('builds into the output directory it is given', () => {
    expect(generated().outDir).toBe(path.join(root, 'out'));
  });

  it('reads env files from the directory it is given', () => {
    expect(generated().vite.envDir).toBe(path.join(root, 'env'));
  });

  it('points the env-file guard at the directory it is given', () => {
    expect(generated().vite.plugins[0]).toEqual({
      name: 'frontend-env-file',
      rootDir: path.join(root, 'env'),
    });
  });

  it('keeps every other plugin as the package configuration has it', () => {
    expect(generated().vite.plugins.slice(1)).toEqual([{ name: 'tailwind' }, [{ name: 'nested' }]]);
  });

  it('keeps the rest of the package configuration', () => {
    const config = generated();
    expect([config.site, config.vite.strictPort]).toEqual(['https://hushbox.ai', true]);
  });
});

describe('dropBakedVariables', () => {
  it('drops every variable the bundler would bake over the env file', () => {
    const env: NodeJS.ProcessEnv = { VITE_API_URL: 'http://localhost', PUBLIC_X: 'x' };
    dropBakedVariables(env);
    expect(env).toEqual({});
  });

  it('keeps every other variable', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/bin', HB_ENV_MODE: 'development' };
    dropBakedVariables(env);
    expect(env).toEqual({ PATH: '/bin', HB_ENV_MODE: 'development' });
  });
});

describe('siteBuildOptions', () => {
  const MARKETING_ROOT = path.resolve(import.meta.dirname, '..');
  const configFile = path.join(MARKETING_ROOT, 'node_modules', '.cache', 'x', 'site.config.mjs');
  const options = siteBuildOptions({ configFile, envDir: '', outDir: '' });

  it('builds the marketing package', () => {
    expect(options.root).toBe(MARKETING_ROOT);
  });

  it('names the configuration relative to the package, which is how the site builder resolves it', () => {
    expect(options.configFile).toBe(path.join('node_modules', '.cache', 'x', 'site.config.mjs'));
  });

  it('builds under production', () => {
    expect(options.mode).toBe('production');
  });
});

describe('the refresh command', () => {
  const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

  it('is what the drift check tells a reader to run', () => {
    const workflow = readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    const drift = /- name: Growth event index drift check\n(?:\s{8,}.*\n)+/u.exec(workflow)?.[0];
    expect(drift).toContain("Run 'pnpm growth:index:refresh'");
  });

  it('is a root script that runs this module', () => {
    const manifest = path.join(REPO_ROOT, 'package.json');
    const scripts = z
      .object({ scripts: z.record(z.string(), z.string()) })
      .parse(JSON.parse(readFileSync(manifest, 'utf8'))).scripts;
    expect(scripts['growth:index:refresh']).toBe(
      'node --import tsx apps/marketing/scripts/refresh-growth-index.ts'
    );
  });
});
