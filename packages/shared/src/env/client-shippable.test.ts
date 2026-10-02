import { describe, it, expect } from 'vitest';
import { Destination, Mode, envConfig, ref, secret, type VariableConfig } from './env.config.ts';
import { frontendRoutingRefusals, shippableEntries } from './client-shippable.ts';
import type { Credential } from './env-types.ts';

/** A credential the rule admits: publishable, held where every build job resolves it. */
const PUBLISHABLE: Credential = {
  description: 'a publishable fixture credential',
  store: 'github:repository',
  replace: 'transparent',
  onLoss: 'reissueAtVendor',
  family: 'helcim-credentials',
  userVisible: 'none',
  leakImpact: 'nuisance',
};

function frontendCredential(credential: Credential): VariableConfig {
  return {
    to: [Destination.Frontend],
    credential,
    [Mode.Development]: 'fixture-placeholder',
    [Mode.Production]: secret('FIXTURE_SECRET'),
  };
}

describe('shippableEntries', () => {
  it('holds an entry whose default destination is the frontend', () => {
    const registry: Record<string, VariableConfig> = {
      VITE_FIXTURE: { to: [Destination.Frontend], [Mode.Development]: 'x' },
    };

    expect([...shippableEntries(registry).keys()]).toEqual(['VITE_FIXTURE']);
  });

  it('holds an entry routed to the frontend by one mode alone', () => {
    const registry: Record<string, VariableConfig> = {
      VITE_FIXTURE: {
        to: [Destination.Backend],
        [Mode.Development]: 'x',
        [Mode.Production]: { value: 'y', to: [Destination.Frontend] },
      },
    };

    expect([...shippableEntries(registry).keys()]).toEqual(['VITE_FIXTURE']);
  });

  it('holds an entry reaching the frontend only through a ref to a routing mode', () => {
    const registry: Record<string, VariableConfig> = {
      VITE_FIXTURE: {
        to: [Destination.Backend],
        [Mode.Development]: { value: 'x', to: [Destination.Frontend] },
        [Mode.Test]: ref(Mode.Development),
      },
    };

    expect(shippableEntries(registry).has('VITE_FIXTURE')).toBe(true);
  });

  it('leaves out an entry no mode routes to the frontend', () => {
    const registry: Record<string, VariableConfig> = {
      NO_VALUE_IN_ANY_MODE: { to: [Destination.Frontend] },
      BACKEND: { to: [Destination.Backend], [Mode.Development]: 'x' },
    };

    expect([...shippableEntries(registry).keys()]).toEqual([]);
  });

  it('carries each entry with its own configuration', () => {
    const config: VariableConfig = { to: [Destination.Frontend], [Mode.Development]: 'x' };

    expect(shippableEntries({ VITE_FIXTURE: config }).get('VITE_FIXTURE')).toBe(config);
  });

  it('reads the registry when given none', () => {
    expect(shippableEntries().get('VITE_API_URL')).toBe(envConfig.VITE_API_URL);
  });
});

describe('frontendRoutingRefusals', () => {
  it('refuses nothing in the registry', () => {
    expect(
      frontendRoutingRefusals(),
      'every value routed to the frontend is served from every origin a client build ships to; a credential that may not be public belongs on a backend destination'
    ).toEqual([]);
  });

  it('still finds entries to judge in the registry', () => {
    expect(
      shippableEntries().size,
      'a rule over an empty set refuses nothing and proves nothing'
    ).toBeGreaterThan(0);
  });

  it('refuses a company-ending credential planted beside the real registry', () => {
    const registry: Record<string, VariableConfig> = {
      ...envConfig,
      VITE_PLANTED: frontendCredential({ ...PUBLISHABLE, leakImpact: 'companyEnding' }),
    };

    expect(frontendRoutingRefusals(registry)).toEqual([
      'VITE_PLANTED: a companyEnding credential is routed to the frontend',
    ]);
  });

  it('refuses a severe credential routed to the frontend', () => {
    const registry = {
      VITE_PLANTED: frontendCredential({ ...PUBLISHABLE, leakImpact: 'severe' }),
    };

    expect(frontendRoutingRefusals(registry)).toEqual([
      'VITE_PLANTED: a severe credential is routed to the frontend',
    ]);
  });

  it('refuses a credential held in a GitHub environment rather than at repository level', () => {
    const registry = {
      VITE_PLANTED: frontendCredential({ ...PUBLISHABLE, store: 'github:production' }),
    };

    expect(frontendRoutingRefusals(registry)).toEqual([
      'VITE_PLANTED: a credential held in github:production is routed to the frontend',
    ]);
  });

  it('refuses a credential routed to the frontend by one mode alone', () => {
    const registry: Record<string, VariableConfig> = {
      VITE_PLANTED: {
        to: [Destination.Backend],
        credential: { ...PUBLISHABLE, leakImpact: 'severe' },
        [Mode.Production]: { value: secret('FIXTURE_SECRET'), to: [Destination.Frontend] },
      },
    };

    expect(frontendRoutingRefusals(registry)).toEqual([
      'VITE_PLANTED: a severe credential is routed to the frontend',
    ]);
  });

  it('admits a publishable credential held at repository level', () => {
    expect(frontendRoutingRefusals({ VITE_PLANTED: frontendCredential(PUBLISHABLE) })).toEqual([]);
  });

  it('admits a publishable credential held only as a Worker secret', () => {
    const registry = {
      VITE_PLANTED: frontendCredential({ ...PUBLISHABLE, store: 'worker-only' }),
    };

    expect(frontendRoutingRefusals(registry)).toEqual([]);
  });

  it('admits a severe credential no mode routes to the frontend', () => {
    const registry: Record<string, VariableConfig> = {
      BACKEND_SECRET: {
        to: [Destination.Backend],
        credential: { ...PUBLISHABLE, leakImpact: 'severe', store: 'github:production' },
        [Mode.Production]: secret('FIXTURE_SECRET'),
      },
    };

    expect(frontendRoutingRefusals(registry)).toEqual([]);
  });

  it('refuses a frontend key planted beside the real registry without the VITE_ prefix', () => {
    const registry: Record<string, VariableConfig> = {
      ...envConfig,
      PLANTED_URL: { to: [Destination.Frontend], [Mode.Development]: 'x' },
    };

    expect(frontendRoutingRefusals(registry)).toEqual([
      'PLANTED_URL: a frontend key must start with VITE_, the prefix the bundler ships',
    ]);
  });

  it('names every clause one entry breaks', () => {
    const registry = {
      PLANTED: frontendCredential({
        ...PUBLISHABLE,
        leakImpact: 'severe',
        store: 'github:ci',
      }),
    };

    expect(frontendRoutingRefusals(registry)).toEqual([
      'PLANTED: a frontend key must start with VITE_, the prefix the bundler ships',
      'PLANTED: a severe credential is routed to the frontend',
      'PLANTED: a credential held in github:ci is routed to the frontend',
    ]);
  });
});
