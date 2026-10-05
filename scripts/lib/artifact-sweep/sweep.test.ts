import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Destination,
  Mode,
  secret,
  type VariableConfig,
} from '../../../packages/shared/src/env/env.config.js';
import { sweepArtifacts } from './sweep.js';
import type { SweepSources } from './registry-values.js';
import type { Credential } from '../../../packages/shared/src/env/env-types.js';

const PRODUCTION_CREDENTIAL: Credential = {
  description: 'a fixture credential',
  store: 'github:production',
  replace: 'transparent',
  onLoss: 'reissueAtVendor',
  family: 'helcim-credentials',
  userVisible: 'none',
  leakImpact: 'severe',
};

/** One backend secret the sweep must never find in a shipped artifact. */
const REGISTRY: Record<string, VariableConfig> = {
  PLANTED_API_KEY: {
    to: [Destination.Backend],
    credential: PRODUCTION_CREDENTIAL,
    [Mode.Production]: secret('PLANTED_API_KEY'),
  },
};

/** The production-shaped value the step binds for the planted entry. */
const PLANTED_VALUE = 'planted-production-value-7f3a9c1e5b';

const ENV = { PLANTED_API_KEY: PLANTED_VALUE };

/**
 * A string the default github-pat rule reports: the prefix and the 36
 * characters the rule captures. Assembled at run time so no committed file
 * carries the shape the repository scan reports.
 */
const CREDENTIAL_SHAPE = ['gh', 'p_', 'Zk7Qm2Xv9Lp4Rt8Ws3Nb6Yh1Jd5Fc0Ga7Ue2'].join('');

/**
 * A config excusing that string the way `.gitleaks.toml` excuses a value: a
 * rule-scoped allowlist on the extended default rule, matching the captured
 * secret exactly.
 */
const EXCUSING_CONFIG = `[extend]
useDefault = true

[[rules]]
id = "github-pat"

[[rules.allowlists]]
description = "the planted fixture token"
regexTarget = "secret"
regexes = ['''^${CREDENTIAL_SHAPE}$''']
`;

/** The sources of a sweep holding only `registry`, with no CI declaration beside it. */
function only(registry: Record<string, VariableConfig>): SweepSources {
  return { registry, ciSecrets: {}, ciIdentifiers: {} };
}

/** Every run of `length` characters in `text`, to prove none of it is printed. */
function windows(text: string, length: number): string[] {
  return Array.from({ length: text.length - length + 1 }, (_, start) =>
    text.slice(start, start + length)
  );
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'artifact-sweep-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A fixture dist whose one chunk holds `content`. */
function fixtureDistribution(content: string): string {
  const distribution = path.join(root, 'dist');
  mkdirSync(path.join(distribution, 'assets'), { recursive: true });
  writeFileSync(
    path.join(distribution, 'index.html'),
    '<!doctype html><script src="assets/app.js">'
  );
  writeFileSync(path.join(distribution, 'assets', 'app.js'), content);
  return distribution;
}

/** A fixture APK: a zip whose bundled web chunk holds `content`, beside a binary dex. */
function fixtureApk(content: string): string {
  const zip = new AdmZip();
  zip.addFile('assets/public/assets/app.js', Buffer.from(content));
  zip.addFile('classes.dex', Buffer.from([0x64, 0x65, 0x78, 0x0a, 0x30, 0x33, 0x35, 0x00]));
  const apk = path.join(root, 'app-release.apk');
  zip.writeZip(apk);
  return apk;
}

async function sweep(
  targets: readonly string[],
  options: { env?: Record<string, string>; gitleaksConfig?: string } = {}
): ReturnType<typeof sweepArtifacts> {
  return sweepArtifacts(targets, {
    env: options.env ?? ENV,
    sources: only(REGISTRY),
    ...(options.gitleaksConfig === undefined ? {} : { gitleaksConfig: options.gitleaksConfig }),
  });
}

describe('sweepArtifacts', () => {
  describe('the value sweep', () => {
    it('passes a dist carrying no production value', async () => {
      const result = await sweep([fixtureDistribution('const a=1;')]);

      expect(result.failed).toBe(false);
    });

    it('fails a dist carrying a production value literally, naming the entry and file', async () => {
      const result = await sweep([fixtureDistribution(`const k="${PLANTED_VALUE}";`)]);

      expect(result.failed).toBe(true);
      expect(result.lines).toContain(
        `found PLANTED_API_KEY (literal) in ${path.join(root, 'dist')}/assets/app.js`
      );
    });

    it('fails a dist carrying a production value base64-encoded', async () => {
      const blob = Buffer.from(`{"k":"${PLANTED_VALUE}"}`).toString('base64');

      const result = await sweep([fixtureDistribution(`const k=atob("${blob}");`)]);

      expect(result.lines.some((line) => line.startsWith('found PLANTED_API_KEY (base64)'))).toBe(
        true
      );
    });

    it('fails a dist carrying a production value in its JSON-escaped spelling', async () => {
      const multiline = `${PLANTED_VALUE}\nsecond-line`;

      const result = await sweep([fixtureDistribution(`const k=${JSON.stringify(multiline)};`)], {
        env: { PLANTED_API_KEY: multiline },
      });

      expect(
        result.lines.some((line) => line.startsWith('found PLANTED_API_KEY (json-escaped)'))
      ).toBe(true);
    });

    it('fails an APK whose bundled chunk carries a production value, naming the entry inside it', async () => {
      const result = await sweep([fixtureApk(`const k="${PLANTED_VALUE}";`)]);

      expect(result.failed).toBe(true);
      expect(result.lines).toContain(
        'found PLANTED_API_KEY (literal) in app-release.apk!/assets/public/assets/app.js'
      );
    });

    it('passes an APK carrying no production value', async () => {
      const result = await sweep([fixtureApk('const a=1;')]);

      expect(result.failed).toBe(false);
    });

    it('fails when the step binds no value to look for', async () => {
      const result = await sweep([fixtureDistribution('const a=1;')], { env: {} });

      expect(result.failed).toBe(true);
      expect(result.lines).toContain(
        'nothing to look for: no production value is bound in this step'
      );
    });

    it('fails a dist carrying a CI signing credential the job holds', async () => {
      const signing = 'planted-signing-password-4c8e2a';

      const result = await sweepArtifacts([fixtureDistribution(`const p="${signing}";`)], {
        env: { ...ENV, SIGNING_PASSWORD: signing },
        sources: {
          registry: REGISTRY,
          ciSecrets: { SIGNING_PASSWORD: PRODUCTION_CREDENTIAL },
          ciIdentifiers: {},
        },
      });

      expect(result.failed).toBe(true);
      expect(result.lines).toContain(
        `found SIGNING_PASSWORD (literal) in ${path.join(root, 'dist')}/assets/app.js`
      );
    });

    it('passes a dist carrying an identifier declared as shipping there', async () => {
      const fingerprint = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55';

      const result = await sweepArtifacts([fixtureDistribution(`const f="${fingerprint}";`)], {
        env: { ...ENV, CERT_FINGERPRINT: fingerprint },
        sources: {
          registry: REGISTRY,
          ciSecrets: {},
          ciIdentifiers: { CERT_FINGERPRINT: { shipsIn: 'the association files' } },
        },
      });

      expect(result.failed).toBe(false);
    });

    it('fails when the registry routes a credential to the frontend that may not ship', async () => {
      const registry: Record<string, VariableConfig> = {
        ...REGISTRY,
        VITE_MISROUTED: {
          to: [Destination.Frontend],
          credential: PRODUCTION_CREDENTIAL,
          [Mode.Production]: secret('VITE_MISROUTED'),
        },
      };

      const result = await sweepArtifacts([fixtureDistribution('const a=1;')], {
        env: ENV,
        sources: only(registry),
      });

      expect(result.failed).toBe(true);
      expect(result.lines).toContain(
        'refused: VITE_MISROUTED: a severe credential is routed to the frontend'
      );
    });

    it('prints each entry it does not sweep with its reason', async () => {
      const registry: Record<string, VariableConfig> = {
        ...REGISTRY,
        BACKUP_KEY: {
          to: [Destination.Backend],
          credential: { ...PRODUCTION_CREDENTIAL, store: 'github:backup' },
          [Mode.Production]: secret('BACKUP_KEY'),
        },
      };

      const result = await sweepArtifacts([fixtureDistribution('const a=1;')], {
        env: ENV,
        sources: only(registry),
      });

      expect(result.failed).toBe(false);
      expect(result.lines).toContain(
        'not swept: BACKUP_KEY — held only in the backup GitHub environment, which a job running under production cannot read'
      );
    });

    it('refuses to run with no target, which would pass having read nothing', async () => {
      await expect(sweep([])).rejects.toThrow('name at least one artifact to sweep');
    });

    it('refuses a file that is not an app archive', async () => {
      const file = path.join(root, 'notes.txt');
      writeFileSync(file, 'text');

      await expect(sweep([file])).rejects.toThrow(/notes\.txt is neither a directory/u);
    });

    it('reads the repository registry when given none', async () => {
      const result = await sweepArtifacts([fixtureDistribution('const a=1;')], { env: {} });

      expect(result.lines).toContain(
        'not swept: BACKUP_REPOSITORY_PASSWORD — held only in the backup GitHub environment, which a job running under production cannot read'
      );
    });

    it('refuses a target that does not exist rather than sweeping nothing', async () => {
      await expect(sweep([path.join(root, 'missing-dist')])).rejects.toThrow(
        /missing-dist does not exist/u
      );
    });
  });

  describe('the credential-shape scan', () => {
    it('fails a dist carrying a credential-shaped string, naming the rule, file and line', async () => {
      const result = await sweep([fixtureDistribution(`const t="${CREDENTIAL_SHAPE}";`)]);

      expect(result.failed).toBe(true);
      expect(result.lines).toContain(
        `credential shape found by github-pat in ${path.join(root, 'dist')}/assets/app.js:1`
      );
    });

    it('fails an APK carrying a credential-shaped string, naming the member inside it', async () => {
      const result = await sweep([fixtureApk(`const t="${CREDENTIAL_SHAPE}";`)]);

      expect(result.failed).toBe(true);
      expect(result.lines).toContain(
        'credential shape found by github-pat in app-release.apk!/assets/public/assets/app.js:1'
      );
    });

    it('prints no planted value, no shape and none of the bytes beside either', async () => {
      const before = 'neighbour-before-the-hit';
      const after = 'neighbour-after-the-hit';
      const chunk = `const a="${before}";const t="${CREDENTIAL_SHAPE}";const k="${PLANTED_VALUE}";const b="${after}";`;

      const result = await sweep([fixtureDistribution(chunk)]);
      const printed = result.lines.join('\n');

      expect(result.failed).toBe(true);
      for (const secretText of [CREDENTIAL_SHAPE, PLANTED_VALUE, before, after]) {
        for (const fragment of windows(secretText, 6)) {
          expect(printed, fragment).not.toContain(fragment);
        }
      }
    });

    it('fails, naming the exit code, when gitleaks cannot run its configuration', async () => {
      const config = path.join(root, 'broken.toml');
      writeFileSync(config, '[[rules]\n');

      const result = await sweep([fixtureDistribution('const a=1;')], { gitleaksConfig: config });

      expect(result.failed).toBe(true);
      expect(
        result.lines.some((line) =>
          line.startsWith(
            `credential shape scan of ${path.join(root, 'dist')} failed with exit code`
          )
        )
      ).toBe(true);
    });

    it('passes a shape the gitleaks configuration excuses', async () => {
      const config = path.join(root, 'gitleaks.toml');
      writeFileSync(config, EXCUSING_CONFIG);

      const result = await sweep([fixtureDistribution(`const t="${CREDENTIAL_SHAPE}";`)], {
        gitleaksConfig: config,
      });

      expect(result.failed).toBe(false);
    });
  });
});
