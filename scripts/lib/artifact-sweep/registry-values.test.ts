import { describe, expect, it } from 'vitest';
import {
  Destination,
  Mode,
  secret,
  type VariableConfig,
} from '../../../packages/shared/src/env/env.config.js';
import {
  PUBLISHING_ENVIRONMENT,
  SWEEP_LENGTH_FLOOR,
  sweepBindings,
  sweepPlan,
  type SweepSources,
} from './registry-values.js';
import type { Credential, SecretStore } from '../../../packages/shared/src/env/env-types.js';

function credential(
  store: SecretStore,
  leakImpact: Credential['leakImpact'] = 'severe'
): Credential {
  return {
    description: 'a fixture credential',
    store,
    replace: 'transparent',
    onLoss: 'reissueAtVendor',
    family: 'helcim-credentials',
    userVisible: 'none',
    leakImpact,
  };
}

function backendSecret(
  store: SecretStore,
  name = 'FIXTURE_SECRET',
  leakImpact: Credential['leakImpact'] = 'severe'
): VariableConfig {
  return {
    to: [Destination.Backend],
    credential: credential(store, leakImpact),
    [Mode.Production]: secret(name),
  };
}

/** The sources of a sweep holding only `registry`, with no CI declaration beside it. */
function only(registry: Readonly<Record<string, VariableConfig>>): SweepSources {
  return { registry, ciSecrets: {}, ciIdentifiers: {} };
}

/** A value long enough to clear the floor, distinct per label. */
function longValue(label: string): string {
  return `${label}-${'x'.repeat(SWEEP_LENGTH_FLOOR)}`;
}

describe('sweepBindings', () => {
  it('binds a production secret held in the production environment under its registry key', () => {
    const { bound } = sweepBindings(
      only({
        API_KEY: backendSecret('github:production', 'API_KEY_PROD'),
      })
    );

    expect(bound).toEqual([{ key: 'API_KEY', secretName: 'API_KEY_PROD' }]);
  });

  it('binds a production secret held at repository level', () => {
    const { bound } = sweepBindings(only({ API_KEY: backendSecret('github:repository') }));

    expect(bound.map(({ key }) => key)).toEqual(['API_KEY']);
  });

  it('leaves a secret held in another GitHub environment unbound, naming that environment', () => {
    const { bound, unbound } = sweepBindings(only({ BACKUP_KEY: backendSecret('github:backup') }));

    expect(bound).toEqual([]);
    expect(unbound).toEqual([
      {
        key: 'BACKUP_KEY',
        reason:
          'held only in the backup GitHub environment, which a job running under production cannot read',
      },
    ]);
  });

  it('leaves a value no GitHub secret stores unbound, saying the run mints it', () => {
    const { unbound } = sweepBindings(only({ MINTED: backendSecret('worker-only') }));

    expect(unbound).toEqual([
      {
        key: 'MINTED',
        reason: 'no GitHub secret stores it; the run that builds or deploys mints it',
      },
    ]);
  });

  it('ignores an entry whose production value is a literal', () => {
    const registry: Record<string, VariableConfig> = {
      PUBLIC_URL: { to: [Destination.Backend], [Mode.Production]: 'https://example.test' },
    };

    expect(sweepBindings(only(registry))).toEqual({ bound: [], unbound: [] });
  });

  it('names every backup-environment entry of the real registry as unbound', () => {
    const { bound, unbound } = sweepBindings();

    expect(unbound.map(({ key }) => key)).toContain('BACKUP_REPOSITORY_PASSWORD');
    expect(bound.map(({ key }) => key)).not.toContain('BACKUP_REPOSITORY_PASSWORD');
    expect(bound.map(({ key }) => key)).toContain('FCM_SERVICE_ACCOUNT_JSON');
  });
});

describe('sweepPlan', () => {
  it('looks for a backend secret the job holds', () => {
    const value = longValue('backend');

    const plan = sweepPlan(
      { API_KEY: value },
      only({ API_KEY: backendSecret('github:production') })
    );

    expect(plan.needles).toEqual([{ key: 'API_KEY', value }]);
  });

  it('does not look for a frontend value, which ships by design', () => {
    const registry: Record<string, VariableConfig> = {
      VITE_TOKEN: {
        to: [Destination.Frontend],
        credential: credential('github:repository', 'nuisance'),
        [Mode.Production]: secret('VITE_TOKEN'),
      },
    };

    const plan = sweepPlan({ VITE_TOKEN: longValue('public') }, only(registry));

    expect(plan.needles).toEqual([]);
  });

  it('does not look for a value the native build compiles into the app', () => {
    const registry: Record<string, VariableConfig> = {
      NATIVE_CONFIG: {
        to: [Destination.Scripts],
        credential: credential('github:production', 'nuisance'),
        [Mode.Production]: { value: secret('NATIVE_CONFIG'), to: [Destination.Native] },
      },
    };

    const plan = sweepPlan({ NATIVE_CONFIG: longValue('native') }, only(registry));

    expect(plan.needles).toEqual([]);
  });

  it('skips a secret equal to a frontend value, saying which entry ships it', () => {
    const shared = longValue('shared');
    const registry: Record<string, VariableConfig> = {
      PUBLIC_KEY: backendSecret('github:production', 'PUBLIC_KEY', 'nuisance'),
      VITE_PUBLIC_KEY: {
        to: [Destination.Frontend],
        credential: credential('github:repository', 'nuisance'),
        [Mode.Production]: secret('VITE_PUBLIC_KEY'),
      },
    };

    const plan = sweepPlan({ PUBLIC_KEY: shared, VITE_PUBLIC_KEY: shared }, only(registry));

    expect(plan.needles).toEqual([]);
    expect(plan.notSwept).toEqual([
      { key: 'PUBLIC_KEY', reason: 'its value equals one that ships (VITE_PUBLIC_KEY)' },
    ]);
  });

  it('skips a secret equal to a frontend literal', () => {
    const shared = longValue('literal');
    const registry: Record<string, VariableConfig> = {
      ORIGIN: backendSecret('github:production', 'ORIGIN', 'nuisance'),
      VITE_ORIGIN: { to: [Destination.Frontend], [Mode.Production]: shared },
    };

    expect(sweepPlan({ ORIGIN: shared }, only(registry)).needles).toEqual([]);
  });

  it('skips a secret equal to a string field of a native-baked base64 JSON document', () => {
    const projectId = longValue('project');
    const document = JSON.stringify({ project_info: { project_id: projectId }, version: '1' });
    const registry: Record<string, VariableConfig> = {
      PROJECT_ID: backendSecret('github:production', 'PROJECT_ID', 'nuisance'),
      NATIVE_CONFIG: {
        to: [Destination.Native],
        credential: credential('github:production', 'nuisance'),
        [Mode.Production]: secret('NATIVE_CONFIG'),
      },
    };
    const env = {
      PROJECT_ID: projectId,
      NATIVE_CONFIG: Buffer.from(document).toString('base64'),
    };

    const plan = sweepPlan(env, only(registry));

    expect(plan.needles).toEqual([]);
    expect(plan.notSwept).toEqual([
      { key: 'PROJECT_ID', reason: 'its value equals one that ships (NATIVE_CONFIG)' },
    ]);
  });

  it('still looks for a secret when a native-baked value is not a JSON document', () => {
    const value = longValue('backend');
    const registry: Record<string, VariableConfig> = {
      API_KEY: backendSecret('github:production'),
      NATIVE_CONFIG: {
        to: [Destination.Native],
        credential: credential('github:production', 'nuisance'),
        [Mode.Production]: secret('NATIVE_CONFIG'),
      },
    };

    const plan = sweepPlan({ API_KEY: value, NATIVE_CONFIG: 'not base64 json' }, only(registry));

    expect(plan.needles).toEqual([{ key: 'API_KEY', value }]);
  });

  it(`skips a value shorter than ${String(SWEEP_LENGTH_FLOOR)} characters, saying so`, () => {
    const short = 'x'.repeat(SWEEP_LENGTH_FLOOR - 1);

    const plan = sweepPlan({ REGION: short }, only({ REGION: backendSecret('github:production') }));

    expect(plan.needles).toEqual([]);
    expect(plan.notSwept).toEqual([
      {
        key: 'REGION',
        reason: `shorter than ${String(SWEEP_LENGTH_FLOOR)} characters, where a match is coincidence rather than evidence`,
      },
    ]);
  });

  it('looks for a value exactly at the floor', () => {
    const value = 'x'.repeat(SWEEP_LENGTH_FLOOR);

    const plan = sweepPlan({ TOKEN: value }, only({ TOKEN: backendSecret('github:production') }));

    expect(plan.needles).toEqual([{ key: 'TOKEN', value }]);
  });

  it('reports a bound secret with no value in this job as not swept', () => {
    const plan = sweepPlan({}, only({ NEXT_KEY: backendSecret('github:production') }));

    expect(plan.notSwept).toEqual([
      { key: 'NEXT_KEY', reason: 'no value is bound to it in this job' },
    ]);
  });

  it('reports a secret this job cannot read as not swept, with the binding reason', () => {
    const plan = sweepPlan(
      { BACKUP_KEY: longValue('backup') },
      only({ BACKUP_KEY: backendSecret('github:backup') })
    );

    expect(plan.needles).toEqual([]);
    expect(plan.notSwept.map(({ key }) => key)).toEqual(['BACKUP_KEY']);
  });

  it('carries the frontend routing refusals, so a mis-routed credential is never allowed', () => {
    const registry: Record<string, VariableConfig> = {
      VITE_LEAKED: {
        to: [Destination.Frontend],
        credential: credential('github:production', 'severe'),
        [Mode.Production]: secret('VITE_LEAKED'),
      },
    };

    expect(sweepPlan({ VITE_LEAKED: longValue('leaked') }, only(registry)).refusals).toEqual([
      'VITE_LEAKED: a severe credential is routed to the frontend',
      'VITE_LEAKED: a credential held in github:production is routed to the frontend',
    ]);
  });

  it('refuses nothing over the real registry', () => {
    expect(sweepPlan({}).refusals).toEqual([]);
  });

  it('looks for a secret equal to a shipped value when its leak is more severe', () => {
    const shared = longValue('pasted');
    const registry: Record<string, VariableConfig> = {
      PRIVATE_KEY: backendSecret('github:production', 'PRIVATE_KEY', 'severe'),
      VITE_PUBLIC_KEY: {
        to: [Destination.Frontend],
        credential: credential('github:repository', 'nuisance'),
        [Mode.Production]: secret('VITE_PUBLIC_KEY'),
      },
    };

    const plan = sweepPlan({ PRIVATE_KEY: shared, VITE_PUBLIC_KEY: shared }, only(registry));

    expect(plan.needles).toEqual([{ key: 'PRIVATE_KEY', value: shared }]);
  });

  it('carries the native routing refusals', () => {
    const registry: Record<string, VariableConfig> = {
      NATIVE_KEY: {
        to: [Destination.Native],
        credential: credential('github:production', 'severe'),
        [Mode.Production]: secret('NATIVE_KEY'),
      },
    };

    expect(sweepPlan({}, only(registry)).refusals).toEqual([
      'NATIVE_KEY: a severe credential is routed into the native build',
    ]);
  });

  it('refuses a production secret marker with no credential declaration, naming the entry', () => {
    const registry: Record<string, VariableConfig> = {
      UNDECLARED: { to: [Destination.Backend], [Mode.Production]: secret('UNDECLARED') },
    };

    expect(() => sweepPlan({}, only(registry))).toThrow(
      'UNDECLARED holds a production secret but declares no credential'
    );
  });
});

describe('the CI declarations', () => {
  it('binds a CI credential a publishing job can read under its own name', () => {
    const { bound } = sweepBindings({
      registry: {},
      ciSecrets: { DEPLOY_TOKEN: credential('github:production') },
      ciIdentifiers: {},
    });

    expect(bound).toEqual([{ key: 'DEPLOY_TOKEN', secretName: 'DEPLOY_TOKEN' }]);
  });

  it('leaves a CI credential held in another environment unbound, naming it', () => {
    const { unbound } = sweepBindings({
      registry: {},
      ciSecrets: { CI_TOKEN: credential('github:ci') },
      ciIdentifiers: {},
    });

    expect(unbound).toEqual([
      {
        key: 'CI_TOKEN',
        reason: `held only in the ci GitHub environment, which a job running under ${PUBLISHING_ENVIRONMENT} cannot read`,
      },
    ]);
  });

  it('looks for a CI credential the job holds', () => {
    const value = longValue('signing');

    const plan = sweepPlan(
      { SIGNING_PASSWORD: value },
      {
        registry: {},
        ciSecrets: { SIGNING_PASSWORD: credential('github:production') },
        ciIdentifiers: {},
      }
    );

    expect(plan.needles).toEqual([{ key: 'SIGNING_PASSWORD', value }]);
  });

  it('binds an identifier declared as shipping, and never looks for it', () => {
    const sources: SweepSources = {
      registry: {},
      ciSecrets: {},
      ciIdentifiers: { TEAM_ID: { shipsIn: 'the association files' }, KEY_ID: {} },
    };

    expect(sweepBindings(sources).bound).toEqual([{ key: 'TEAM_ID', secretName: 'TEAM_ID' }]);
    expect(sweepPlan({ TEAM_ID: longValue('team') }, sources).needles).toEqual([]);
  });

  it('allows a shipping identifier: a credential no more severe holding its value is skipped', () => {
    const shared = longValue('team');
    const sources: SweepSources = {
      registry: {},
      ciSecrets: { BUCKET_NAME: credential('github:repository', 'nuisance') },
      ciIdentifiers: { TEAM_ID: { shipsIn: 'the association files' } },
    };

    const plan = sweepPlan({ BUCKET_NAME: shared, TEAM_ID: shared }, sources);

    expect(plan.needles).toEqual([]);
    expect(plan.notSwept).toEqual([
      { key: 'BUCKET_NAME', reason: 'its value equals one that ships (TEAM_ID)' },
    ]);
  });

  it('binds the real deploy, signing and store credentials and the deep-link pair', () => {
    const keys = sweepBindings().bound.map(({ key }) => key);

    expect(keys).toEqual(
      expect.arrayContaining([
        'CLOUDFLARE_API_TOKEN',
        'ANDROID_KEYSTORE_PASSWORD',
        'ASC_KEY_CONTENT',
        'PLAY_STORE_JSON_KEY',
        'APPLE_TEAM_ID',
        'ANDROID_CERT_SHA256_FINGERPRINT',
      ])
    );
    expect(keys).not.toContain('GITLEAKS_LICENSE');
  });
});
