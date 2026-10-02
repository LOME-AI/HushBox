import { describe, it, expect } from 'vitest';
import { Mode, resolveRaw } from '@hushbox/shared';
import { envConfig } from '@hushbox/shared/env.config';
import {
  COMPOSE_ENV_VARIABLES,
  composeEnvValues,
  developmentValue,
  escrowBucketFrom,
  postgresRoleFrom,
} from './compose-env.js';
import { DEFAULT_STACK_MODE } from './stack-mode.js';
import { applyStackDatabase, databaseNameOf } from './stack-database.js';
import type { VariableConfig } from '@hushbox/shared';

/** The development value the registry holds for one of its entries. */
function registryDevelopmentValue(name: keyof typeof envConfig): string {
  const raw = resolveRaw(envConfig[name] as VariableConfig, Mode.Development);
  if (typeof raw !== 'string') throw new Error(`${name} carries no literal development value`);
  return raw;
}

describe('composeEnvValues', () => {
  it('names the database the default stack resolves', () => {
    const values = composeEnvValues();

    expect(values[COMPOSE_ENV_VARIABLES.postgresDb]).toBe(
      databaseNameOf(
        applyStackDatabase(registryDevelopmentValue('DATABASE_URL'), DEFAULT_STACK_MODE)
      )
    );
  });

  it('carries the user the registry connection string signs in as', () => {
    const values = composeEnvValues();

    expect(values[COMPOSE_ENV_VARIABLES.postgresUser]).toBe(
      new URL(registryDevelopmentValue('DATABASE_URL')).username
    );
  });

  it('carries the password the registry connection string signs in with', () => {
    const values = composeEnvValues();

    expect(values[COMPOSE_ENV_VARIABLES.postgresPassword]).toBe(
      new URL(registryDevelopmentValue('DATABASE_URL')).password
    );
  });

  it('gives the object store the access key id its clients present', () => {
    const values = composeEnvValues();

    expect(values[COMPOSE_ENV_VARIABLES.minioRootUser]).toBe(
      registryDevelopmentValue('R2_ACCESS_KEY_ID')
    );
  });

  it('gives the object store the secret key its clients sign with', () => {
    const values = composeEnvValues();

    expect(values[COMPOSE_ENV_VARIABLES.minioRootPassword]).toBe(
      registryDevelopmentValue('R2_SECRET_ACCESS_KEY')
    );
  });

  it('names a non-empty bucket for every variable it writes', () => {
    const empty = Object.entries(composeEnvValues()).filter(([, value]) => value === '');

    expect(empty).toStrictEqual([]);
  });
});

describe('developmentValue', () => {
  it('refuses an entry that resolves no development literal', () => {
    const withoutLiteral = Object.keys(envConfig).find(
      (name) =>
        typeof resolveRaw(
          envConfig[name as keyof typeof envConfig] as VariableConfig,
          Mode.Development
        ) !== 'string'
    );

    expect(
      withoutLiteral,
      'every registry entry now resolves a development literal, so this refusal asserts over nothing'
    ).toBeDefined();
    expect(() => developmentValue(withoutLiteral as keyof typeof envConfig)).toThrow(
      /no development value/
    );
  });
});

describe('escrowBucketFrom', () => {
  it('reads the bucket the environment names', () => {
    expect(escrowBucketFrom({ [COMPOSE_ENV_VARIABLES.escrowBucket]: 'a-bucket' })).toBe('a-bucket');
  });

  it('reads the variable the generator writes the bucket into', () => {
    expect(escrowBucketFrom({ ...composeEnvValues() })).toBe(
      composeEnvValues()[COMPOSE_ENV_VARIABLES.escrowBucket]
    );
  });

  it('refuses an environment that names no bucket', () => {
    expect(() => escrowBucketFrom({})).toThrow(/stack env is not loaded/);
  });

  it('refuses an environment whose bucket variable is empty', () => {
    expect(() => escrowBucketFrom({ [COMPOSE_ENV_VARIABLES.escrowBucket]: '' })).toThrow(
      /stack env is not loaded/
    );
  });
});

describe('postgresRoleFrom', () => {
  it('reads the role the environment names', () => {
    expect(postgresRoleFrom({ [COMPOSE_ENV_VARIABLES.postgresUser]: 'a-role' })).toBe('a-role');
  });

  it('reads the variable the generator writes the role into', () => {
    expect(postgresRoleFrom({ ...composeEnvValues() })).toBe(
      composeEnvValues()[COMPOSE_ENV_VARIABLES.postgresUser]
    );
  });

  it('refuses an environment that names no role', () => {
    expect(() => postgresRoleFrom({})).toThrow(/stack env is not loaded/);
  });

  it('refuses an environment whose role variable is empty', () => {
    expect(() => postgresRoleFrom({ [COMPOSE_ENV_VARIABLES.postgresUser]: '' })).toThrow(
      /stack env is not loaded/
    );
  });
});
