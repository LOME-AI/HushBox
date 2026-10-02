import { describe, it, expect } from 'vitest';
import {
  STACK_BUCKET_MARKER,
  STACK_DATABASE_MARKER,
  envConfig,
  backendEnvSchema,
  Destination,
  Mode,
  isSecret,
  isAnyModeSecret,
  getDestinations,
  resolveRaw,
  type VariableConfig,
} from './env.config.ts';
import { ENV_FLAG_TRUE } from './env.ts';
import { BRAVE_SEARCH_API_KEY_PLACEHOLDER } from './local-placeholders.ts';
import { getModeValue, isRef, type EnvMode } from './env-types.ts';

/** A variable's development value, refused unless the registry states it as a literal. */
function devLiteral(config: VariableConfig): string {
  const raw = resolveRaw(config, Mode.Development);
  if (typeof raw !== 'string') throw new Error('expected a development string literal');
  return raw;
}

describe('envConfig', () => {
  describe('DATABASE_URL', () => {
    it('has development value going to Backend + Scripts', () => {
      expect(getDestinations(envConfig.DATABASE_URL, Mode.Development)).toEqual([
        Destination.Backend,
        Destination.Scripts,
      ]);
    });

    it('inherits Dev destinations through ref in CiVitest, E2E, and CiE2E', () => {
      expect(getDestinations(envConfig.DATABASE_URL, Mode.CiVitest)).toEqual([
        Destination.Backend,
        Destination.Scripts,
      ]);
      expect(getDestinations(envConfig.DATABASE_URL, Mode.E2E)).toEqual([
        Destination.Backend,
        Destination.Scripts,
      ]);
      expect(getDestinations(envConfig.DATABASE_URL, Mode.CiE2E)).toEqual([
        Destination.Backend,
        Destination.Scripts,
      ]);
    });

    it('has production secret going to Backend only', () => {
      expect(getDestinations(envConfig.DATABASE_URL, Mode.Production)).toEqual([
        Destination.Backend,
      ]);
      const raw = resolveRaw(envConfig.DATABASE_URL, Mode.Production);
      expect(isSecret(raw)).toBe(true);
    });
  });

  describe('the local Postgres URLs', () => {
    const LOCAL_POSTGRES_KEYS = [
      'DATABASE_URL',
      'ADMIN_SQL_PANEL_DATABASE_URL',
      'MIGRATION_DATABASE_URL',
    ] as const;

    // Each MUST ask for the stack's database rather than name one, exactly as
    // it names a service rather than a port: `scripts/generate-env.ts`
    // substitutes the database of the stack whose files it is writing, and a
    // name written here would be a second spelling of the stack's identity.
    it.each(LOCAL_POSTGRES_KEYS)('asks %s for the stack own database', (key) => {
      expect(resolveRaw(envConfig[key], Mode.Development)).toContain(STACK_DATABASE_MARKER);
    });

    it.each(LOCAL_POSTGRES_KEYS)('resolves %s the same way in every local mode', (key) => {
      for (const mode of [Mode.CiVitest, Mode.E2E, Mode.CiE2E]) {
        expect(resolveRaw(envConfig[key], mode)).toContain(STACK_DATABASE_MARKER);
      }
    });

    it('keeps the production connection string a secret, with no marker to substitute', () => {
      expect(isSecret(resolveRaw(envConfig.DATABASE_URL, Mode.Production))).toBe(true);
      expect(isSecret(resolveRaw(envConfig.ADMIN_SQL_PANEL_DATABASE_URL, Mode.Production))).toBe(
        true
      );
      expect(resolveRaw(envConfig.MIGRATION_DATABASE_URL, Mode.Production)).toBeUndefined();
    });
  });

  describe('NODE_ENV', () => {
    it('goes to Backend only', () => {
      expect(envConfig.NODE_ENV.to).toEqual([Destination.Backend]);
    });

    it('has development value', () => {
      expect(resolveRaw(envConfig.NODE_ENV, Mode.Development)).toBe('development');
    });

    it('has production value', () => {
      expect(resolveRaw(envConfig.NODE_ENV, Mode.Production)).toBe('production');
    });

    it('refs development for CI environments', () => {
      expect(resolveRaw(envConfig.NODE_ENV, Mode.CiVitest)).toBe('development');
      expect(resolveRaw(envConfig.NODE_ENV, Mode.E2E)).toBe('development');
    });
  });

  describe('API_URL', () => {
    it('goes to Backend only', () => {
      expect(envConfig.API_URL.to).toEqual([Destination.Backend]);
    });

    it('has dev and prod values', () => {
      expect(resolveRaw(envConfig.API_URL, Mode.Development)).toBe('http://api.localhost');
      expect(resolveRaw(envConfig.API_URL, Mode.Production)).toBe('https://api.hushbox.ai');
    });
  });

  describe('FRONTEND_URL', () => {
    it('goes to Backend only', () => {
      expect(envConfig.FRONTEND_URL.to).toEqual([Destination.Backend]);
    });

    it('has dev and prod values', () => {
      expect(resolveRaw(envConfig.FRONTEND_URL, Mode.Development)).toBe('http://vite.localhost');
      expect(resolveRaw(envConfig.FRONTEND_URL, Mode.Production)).toBe('https://hushbox.ai');
    });
  });

  describe('MARKETING_URL', () => {
    it('goes to Backend only', () => {
      expect(envConfig.MARKETING_URL.to).toEqual([Destination.Backend]);
    });

    it('names the Astro service in dev and the marketing origin in prod', () => {
      // The dev value MUST name the Astro service, never a port —
      // applyWorktreePorts substitutes the port that service holds for this
      // checkout's slot and stack mode at generation time.
      expect(resolveRaw(envConfig.MARKETING_URL, Mode.Development)).toBe('http://astro.localhost');
      expect(resolveRaw(envConfig.MARKETING_URL, Mode.CiVitest)).toBe('http://astro.localhost');
      expect(resolveRaw(envConfig.MARKETING_URL, Mode.E2E)).toBe('http://astro.localhost');
      expect(resolveRaw(envConfig.MARKETING_URL, Mode.CiE2E)).toBe('http://astro.localhost');
      expect(resolveRaw(envConfig.MARKETING_URL, Mode.Production)).toBe('https://hushbox.ai');
    });
  });

  describe('ADMIN_URL', () => {
    it('goes to Backend only', () => {
      expect(envConfig.ADMIN_URL.to).toEqual([Destination.Backend]);
    });

    it('has an explicit value for every mode (no fallbacks)', () => {
      expect(resolveRaw(envConfig.ADMIN_URL, Mode.Development)).toBe('http://admin.localhost');
      expect(resolveRaw(envConfig.ADMIN_URL, Mode.CiVitest)).toBe('http://admin.localhost');
      expect(resolveRaw(envConfig.ADMIN_URL, Mode.E2E)).toBe('http://admin.localhost');
      expect(resolveRaw(envConfig.ADMIN_URL, Mode.CiE2E)).toBe('http://admin.localhost');
      expect(resolveRaw(envConfig.ADMIN_URL, Mode.Production)).toBe('https://admin.hushbox.ai');
    });
  });

  describe('the document sandbox origin', () => {
    it('resolves to the same origin in every mode as the entry it mirrors', () => {
      const modes = Object.values(Mode);
      const mirrored = modes.map((mode) => resolveRaw(envConfig.VITE_SANDBOX_ORIGIN_URL, mode));

      expect(
        mirrored,
        'a mode resolving to nothing would satisfy the comparison below without naming an origin'
      ).not.toContain(undefined);
      expect(mirrored).toEqual(modes.map((mode) => resolveRaw(envConfig.SANDBOX_ORIGIN_URL, mode)));
    });

    it('sends the mirror to the frontend and the entry it mirrors to scripts', () => {
      expect(envConfig.VITE_SANDBOX_ORIGIN_URL.to).toEqual([Destination.Frontend]);
      expect(envConfig.SANDBOX_ORIGIN_URL.to).toEqual([Destination.Scripts]);
    });
  });

  describe('CI flag', () => {
    it('goes to Backend only', () => {
      expect(envConfig.CI.to).toEqual([Destination.Backend]);
    });

    it('is stated by the CI modes alone, so a non-CI mode writes no line at all', () => {
      expect(resolveRaw(envConfig.CI, Mode.Development)).toBeUndefined();
      expect(resolveRaw(envConfig.CI, Mode.Test)).toBeUndefined();
      expect(resolveRaw(envConfig.CI, Mode.CiVitest)).toBe(ENV_FLAG_TRUE);
      expect(resolveRaw(envConfig.CI, Mode.E2E)).toBeUndefined();
      expect(resolveRaw(envConfig.CI, Mode.CiE2E)).toBe(ENV_FLAG_TRUE);
      expect(resolveRaw(envConfig.CI, Mode.Production)).toBeUndefined();
    });
  });

  describe('E2E flag', () => {
    it('goes to Backend only', () => {
      expect(envConfig.E2E.to).toEqual([Destination.Backend]);
    });

    it('is only set in e2e environment', () => {
      expect(resolveRaw(envConfig.E2E, Mode.Development)).toBeUndefined();
      expect(resolveRaw(envConfig.E2E, Mode.CiVitest)).toBeUndefined();
      expect(resolveRaw(envConfig.E2E, Mode.E2E)).toBe(ENV_FLAG_TRUE);
      expect(resolveRaw(envConfig.E2E, Mode.Production)).toBeUndefined();
    });
  });

  describe('RESEND_API_KEY', () => {
    it('goes to Backend only', () => {
      expect(envConfig.RESEND_API_KEY.to).toEqual([Destination.Backend]);
    });

    it('is only set in production (not in dev or CI)', () => {
      expect(resolveRaw(envConfig.RESEND_API_KEY, Mode.Development)).toBeUndefined();
      expect(resolveRaw(envConfig.RESEND_API_KEY, Mode.CiVitest)).toBeUndefined();
      expect(resolveRaw(envConfig.RESEND_API_KEY, Mode.E2E)).toBeUndefined();
      const production = resolveRaw(envConfig.RESEND_API_KEY, Mode.Production);
      expect(isSecret(production)).toBe(true);
    });
  });

  describe('RESEND_WEBHOOK_SECRET', () => {
    it('goes to Backend only', () => {
      expect(envConfig.RESEND_WEBHOOK_SECRET.to).toEqual([Destination.Backend]);
    });

    it('carries the fixed whsec_ dev literal in every non-production mode', () => {
      const dev = resolveRaw(envConfig.RESEND_WEBHOOK_SECRET, Mode.Development);
      expect(dev).toBe('whsec_bmV3c2xldHRlci1kZXYtd2ViaG9vay1zZWNyZXQ=');
      expect(resolveRaw(envConfig.RESEND_WEBHOOK_SECRET, Mode.CiVitest)).toBe(dev);
      expect(resolveRaw(envConfig.RESEND_WEBHOOK_SECRET, Mode.E2E)).toBe(dev);
      expect(resolveRaw(envConfig.RESEND_WEBHOOK_SECRET, Mode.CiE2E)).toBe(dev);
    });

    it('is a secret in production', () => {
      expect(isSecret(resolveRaw(envConfig.RESEND_WEBHOOK_SECRET, Mode.Production))).toBe(true);
    });
  });

  describe('admin plane (Cloudflare Access) vars', () => {
    it('go to Backend only', () => {
      expect(envConfig.CF_ACCESS_TEAM_DOMAIN.to).toEqual([Destination.Backend]);
      expect(envConfig.CF_ACCESS_AUD.to).toEqual([Destination.Backend]);
      expect(envConfig.ADMIN_ACTOR_ALLOWLIST.to).toEqual([Destination.Backend]);
      expect(envConfig.CF_ACCESS_DEV_PRIVATE_JWK.to).toEqual([Destination.Backend]);
    });

    it('declare the cloudflare-identifiers family, each one individually', () => {
      expect(envConfig.CF_ACCESS_TEAM_DOMAIN.credential.family).toBe('cloudflare-identifiers');
      expect(envConfig.CF_ACCESS_AUD.credential.family).toBe('cloudflare-identifiers');
      expect(envConfig.ADMIN_ACTOR_ALLOWLIST.credential.family).toBe('cloudflare-identifiers');
      expect(envConfig.CLOUDFLARE_ACCOUNT_ID.credential.family).toBe('cloudflare-identifiers');
    });

    it('carry dev literals the dev-admin mint signs against in every non-Production mode', () => {
      expect(resolveRaw(envConfig.CF_ACCESS_TEAM_DOMAIN, Mode.Development)).toBe('hushbox-dev');
      expect(resolveRaw(envConfig.CF_ACCESS_AUD, Mode.Development)).toBe('dev-admin-access-aud');
      expect(resolveRaw(envConfig.ADMIN_ACTOR_ALLOWLIST, Mode.Development)).toBe(
        'admin@hushbox.test,ops@hushbox.test,viewer@hushbox.test'
      );
      for (const mode of [Mode.CiVitest, Mode.E2E, Mode.CiE2E]) {
        expect(resolveRaw(envConfig.CF_ACCESS_TEAM_DOMAIN, mode)).toBe('hushbox-dev');
        expect(resolveRaw(envConfig.CF_ACCESS_AUD, mode)).toBe('dev-admin-access-aud');
        expect(resolveRaw(envConfig.CF_ACCESS_DEV_PRIVATE_JWK, mode)).toBe(
          resolveRaw(envConfig.CF_ACCESS_DEV_PRIVATE_JWK, Mode.Development)
        );
      }
    });

    it('spell every development admin address on the one dev admin domain', () => {
      const domainOf = (address: string): string | undefined => address.trim().split('@')[1];
      const domains = new Set([
        ...devLiteral(envConfig.ADMIN_ACTOR_ALLOWLIST)
          .split(',')
          .map((address) => domainOf(address)),
        ...devLiteral(envConfig.ADMIN_ROLE_MAP)
          .split(',')
          .map((entry) => domainOf(entry.split('=')[0] ?? '')),
      ]);
      expect([...domains]).toEqual(['hushbox.test']);
    });

    it('allowlist every development role-map address — the wall admits on both bindings', () => {
      const allowlisted = new Set(devLiteral(envConfig.ADMIN_ACTOR_ALLOWLIST).split(','));
      const roleMapAddresses = devLiteral(envConfig.ADMIN_ROLE_MAP)
        .split(',')
        .map((entry) => entry.split('=')[0] ?? '');
      expect(roleMapAddresses.filter((address) => !allowlisted.has(address))).toEqual([]);
    });

    it('the dev signing key is a private Ed25519 JWK (the mint route needs `d`)', () => {
      const raw = resolveRaw(envConfig.CF_ACCESS_DEV_PRIVATE_JWK, Mode.Development);
      expect(typeof raw).toBe('string');
      const jwk = JSON.parse(raw as string) as Record<string, unknown>;
      expect(jwk['kty']).toBe('OKP');
      expect(jwk['crv']).toBe('Ed25519');
      expect(typeof jwk['d']).toBe('string');
      expect(typeof jwk['x']).toBe('string');
    });

    it('resolve the real Access app values as secrets in Production', () => {
      expect(isSecret(resolveRaw(envConfig.CF_ACCESS_TEAM_DOMAIN, Mode.Production))).toBe(true);
      expect(isSecret(resolveRaw(envConfig.CF_ACCESS_AUD, Mode.Production))).toBe(true);
      expect(isSecret(resolveRaw(envConfig.ADMIN_ACTOR_ALLOWLIST, Mode.Production))).toBe(true);
    });

    it('Production carries NO dev signing key — nothing deployable can mint admin access', () => {
      expect(resolveRaw(envConfig.CF_ACCESS_DEV_PRIVATE_JWK, Mode.Production)).toBeUndefined();
    });
  });

  describe('OPENROUTER_API_KEY', () => {
    it('goes to Backend only', () => {
      expect(envConfig.OPENROUTER_API_KEY.to).toEqual([Destination.Backend]);
    });

    it('uses a mock placeholder in Development, E2E, and CiE2E (cassette-replay fixtures)', () => {
      expect(resolveRaw(envConfig.OPENROUTER_API_KEY, Mode.Development)).toBe(
        'mock-openrouter-key'
      );
      expect(resolveRaw(envConfig.OPENROUTER_API_KEY, Mode.E2E)).toBe('mock-openrouter-key');
      expect(resolveRaw(envConfig.OPENROUTER_API_KEY, Mode.CiE2E)).toBe('mock-openrouter-key');
    });

    it('resolves the spend-restricted secret in CiVitest (backs real-call tests)', () => {
      const raw = resolveRaw(envConfig.OPENROUTER_API_KEY, Mode.CiVitest);
      expect(isSecret(raw)).toBe(true);
      expect(isSecret(raw) && raw.name).toBe('OPENROUTER_API_KEY_RESTRICTED');
    });

    it('resolves the production secret in Production', () => {
      expect(isSecret(resolveRaw(envConfig.OPENROUTER_API_KEY, Mode.Production))).toBe(true);
    });
  });

  describe('BRAVE_SEARCH_API_KEY', () => {
    it('goes to Backend only', () => {
      expect(envConfig.BRAVE_SEARCH_API_KEY.to).toEqual([Destination.Backend]);
    });

    it('uses the published placeholder in every local mode, so no local stack holds a Brave key', () => {
      for (const mode of [Mode.Development, Mode.Test, Mode.E2E, Mode.CiE2E]) {
        expect(resolveRaw(envConfig.BRAVE_SEARCH_API_KEY, mode)).toBe(
          BRAVE_SEARCH_API_KEY_PLACEHOLDER
        );
      }
    });

    it('resolves the restricted secret in CiVitest', () => {
      const raw = resolveRaw(envConfig.BRAVE_SEARCH_API_KEY, Mode.CiVitest);
      expect(isSecret(raw) && raw.name).toBe('BRAVE_SEARCH_API_KEY_RESTRICTED');
    });

    it('resolves the production secret in Production', () => {
      const raw = resolveRaw(envConfig.BRAVE_SEARCH_API_KEY, Mode.Production);
      expect(isSecret(raw) && raw.name).toBe('BRAVE_SEARCH_API_KEY_PRODUCTION');
    });

    it('declares its credential in the brave-search-key family', () => {
      expect(envConfig.BRAVE_SEARCH_API_KEY.credential.family).toBe('brave-search-key');
    });
  });

  describe('HELCIM_API_TOKEN', () => {
    it('goes to Backend only', () => {
      expect(envConfig.HELCIM_API_TOKEN.to).toEqual([Destination.Backend]);
    });

    it('is only in ciE2E and production (NOT development, ciVitest, or e2e)', () => {
      expect(resolveRaw(envConfig.HELCIM_API_TOKEN, Mode.Development)).toBeUndefined();
      expect(resolveRaw(envConfig.HELCIM_API_TOKEN, Mode.CiVitest)).toBeUndefined();
      expect(resolveRaw(envConfig.HELCIM_API_TOKEN, Mode.E2E)).toBeUndefined();
      expect(resolveRaw(envConfig.HELCIM_API_TOKEN, Mode.CiE2E)).toBeDefined();
      expect(resolveRaw(envConfig.HELCIM_API_TOKEN, Mode.Production)).toBeDefined();
    });

    it('uses different secrets for ciE2E and production', () => {
      const ciE2E = resolveRaw(envConfig.HELCIM_API_TOKEN, Mode.CiE2E);
      const production = resolveRaw(envConfig.HELCIM_API_TOKEN, Mode.Production);
      expect(isSecret(ciE2E)).toBe(true);
      expect(isSecret(production)).toBe(true);
      expect(ciE2E).not.toEqual(production);
    });
  });

  describe('HELCIM_WEBHOOK_VERIFIER', () => {
    it('goes to Backend only', () => {
      expect(envConfig.HELCIM_WEBHOOK_VERIFIER.to).toEqual([Destination.Backend]);
    });

    it('has mock value for development (for local webhook testing)', () => {
      const dev = resolveRaw(envConfig.HELCIM_WEBHOOK_VERIFIER, Mode.Development);
      expect(dev).toBeDefined();
      expect(typeof dev).toBe('string');
      expect(isSecret(dev)).toBe(false);
    });

    it('e2e uses development mock value', () => {
      const e2e = resolveRaw(envConfig.HELCIM_WEBHOOK_VERIFIER, Mode.E2E);
      const dev = resolveRaw(envConfig.HELCIM_WEBHOOK_VERIFIER, Mode.Development);
      expect(e2e).toBe(dev);
    });

    it('uses different secrets for ciE2E and production', () => {
      const ciE2E = resolveRaw(envConfig.HELCIM_WEBHOOK_VERIFIER, Mode.CiE2E);
      const production = resolveRaw(envConfig.HELCIM_WEBHOOK_VERIFIER, Mode.Production);
      expect(isSecret(ciE2E)).toBe(true);
      expect(isSecret(production)).toBe(true);
      expect(ciE2E).not.toEqual(production);
    });
  });

  describe('VITE_API_URL', () => {
    it('goes to Frontend only', () => {
      expect(envConfig.VITE_API_URL.to).toEqual([Destination.Frontend]);
    });

    it('has dev and prod values', () => {
      expect(resolveRaw(envConfig.VITE_API_URL, Mode.Development)).toBe('http://api.localhost');
      expect(resolveRaw(envConfig.VITE_API_URL, Mode.Production)).toBe('https://api.hushbox.ai');
    });
  });

  describe('VITE_WEB_URL', () => {
    it('goes to Frontend only', () => {
      expect(envConfig.VITE_WEB_URL.to).toEqual([Destination.Frontend]);
    });

    it('has dev and prod values', () => {
      expect(resolveRaw(envConfig.VITE_WEB_URL, Mode.Development)).toBe('http://vite.localhost');
      expect(resolveRaw(envConfig.VITE_WEB_URL, Mode.Production)).toBe('https://hushbox.ai');
    });

    it('is defined for every mode, including production (unlike dev-only VITE_ADMIN_URL)', () => {
      expect(resolveRaw(envConfig.VITE_WEB_URL, Mode.CiVitest)).toBe('http://vite.localhost');
      expect(resolveRaw(envConfig.VITE_WEB_URL, Mode.E2E)).toBe('http://vite.localhost');
      expect(resolveRaw(envConfig.VITE_WEB_URL, Mode.CiE2E)).toBe('http://vite.localhost');
      expect(resolveRaw(envConfig.VITE_WEB_URL, Mode.Production)).toBeDefined();
    });
  });

  describe('VITE_HELCIM_JS_TOKEN', () => {
    it('goes to Frontend only', () => {
      expect(envConfig.VITE_HELCIM_JS_TOKEN.to).toEqual([Destination.Frontend]);
    });

    it('carries a mock placeholder in the mock-tokenizer modes and a real token in ciE2E and production (NOT e2e)', () => {
      expect(resolveRaw(envConfig.VITE_HELCIM_JS_TOKEN, Mode.Development)).toBe(
        'mock-helcim-js-token'
      );
      expect(resolveRaw(envConfig.VITE_HELCIM_JS_TOKEN, Mode.CiVitest)).toBe(
        'mock-helcim-js-token'
      );
      expect(resolveRaw(envConfig.VITE_HELCIM_JS_TOKEN, Mode.E2E)).toBeUndefined();
      expect(resolveRaw(envConfig.VITE_HELCIM_JS_TOKEN, Mode.CiE2E)).toBeDefined();
      expect(resolveRaw(envConfig.VITE_HELCIM_JS_TOKEN, Mode.Production)).toBeDefined();
    });
  });

  describe('VITE_APP_VERSION', () => {
    it('goes to Frontend only', () => {
      expect(envConfig.VITE_APP_VERSION.to).toEqual([Destination.Frontend]);
    });

    it('has dev-local for development', () => {
      expect(resolveRaw(envConfig.VITE_APP_VERSION, Mode.Development)).toBe('dev-local');
    });

    it('takes its production value from a marker, so no literal can be baked instead', () => {
      const raw = resolveRaw(envConfig.VITE_APP_VERSION, Mode.Production);

      expect(isSecret(raw) ? raw.name : raw).toBe('VITE_APP_VERSION');
    });

    it('is minted per deploy, as the version its backend twin serves is', () => {
      expect(envConfig.VITE_APP_VERSION.credential.onLoss).toBe(
        envConfig.APP_VERSION.credential.onLoss
      );
    });

    it('belongs to the family its backend twin belongs to', () => {
      expect(envConfig.VITE_APP_VERSION.credential.family).toBe(
        envConfig.APP_VERSION.credential.family
      );
    });

    it('is backed by no stored secret, as its backend twin is not', () => {
      expect(envConfig.VITE_APP_VERSION.credential.store).toBe(
        envConfig.APP_VERSION.credential.store
      );
    });
  });

  describe('the legal effective dates', () => {
    const DATES = [
      envConfig.VITE_PRIVACY_POLICY_EFFECTIVE_DATE,
      envConfig.VITE_TERMS_OF_SERVICE_EFFECTIVE_DATE,
    ];

    it('goes to Frontend only', () => {
      for (const config of DATES) expect(config.to).toEqual([Destination.Frontend]);
    });

    it('carries a well-formed day for development, so a checkout with no release still renders one', () => {
      for (const config of DATES) expect(devLiteral(config)).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    });

    it('names no day a reader could mistake for a published one outside production', () => {
      // The epoch, restated rather than imported: an assertion that reads the registry's own
      // constant cannot catch the registry being given a plausible-looking day.
      for (const config of DATES) expect(devLiteral(config)).toBe('1970-01-01');
    });

    it('takes its production value from a marker, so no typed date can be baked instead', () => {
      for (const config of DATES) {
        const raw = resolveRaw(config, Mode.Production);
        expect(isSecret(raw)).toBe(true);
      }
    });

    it('is minted per deploy, as the version baked beside it is', () => {
      for (const config of DATES) {
        expect(config.credential.onLoss).toBe(envConfig.VITE_APP_VERSION.credential.onLoss);
        expect(config.credential.store).toBe(envConfig.VITE_APP_VERSION.credential.store);
        expect(config.credential.family).toBe(envConfig.VITE_APP_VERSION.credential.family);
      }
    });
  });

  describe('VITE_CI', () => {
    it('goes to Frontend only', () => {
      expect(envConfig.VITE_CI.to).toEqual([Destination.Frontend]);
    });

    it('is only set in CI environments', () => {
      expect(resolveRaw(envConfig.VITE_CI, Mode.Development)).toBeUndefined();
      expect(resolveRaw(envConfig.VITE_CI, Mode.CiVitest)).toBe(ENV_FLAG_TRUE);
      expect(resolveRaw(envConfig.VITE_CI, Mode.E2E)).toBeUndefined();
      expect(resolveRaw(envConfig.VITE_CI, Mode.CiE2E)).toBe(ENV_FLAG_TRUE);
      expect(resolveRaw(envConfig.VITE_CI, Mode.Production)).toBeUndefined();
    });
  });

  describe('VITE_E2E', () => {
    it('goes to Frontend only', () => {
      expect(envConfig.VITE_E2E.to).toEqual([Destination.Frontend]);
    });

    it('is only set in e2e environments (never production)', () => {
      expect(resolveRaw(envConfig.VITE_E2E, Mode.Development)).toBeUndefined();
      expect(resolveRaw(envConfig.VITE_E2E, Mode.CiVitest)).toBeUndefined();
      expect(resolveRaw(envConfig.VITE_E2E, Mode.E2E)).toBe(ENV_FLAG_TRUE);
      expect(resolveRaw(envConfig.VITE_E2E, Mode.CiE2E)).toBe(ENV_FLAG_TRUE);
      expect(resolveRaw(envConfig.VITE_E2E, Mode.Production)).toBeUndefined();
    });
  });

  describe('R2_S3_ENDPOINT', () => {
    it('goes to Backend only', () => {
      expect(envConfig.R2_S3_ENDPOINT.to).toEqual([Destination.Backend]);
    });

    it('has MinIO endpoint for development', () => {
      expect(resolveRaw(envConfig.R2_S3_ENDPOINT, Mode.Development)).toBe(
        'http://minioapi.localhost'
      );
    });

    it('refs development for CI/E2E environments', () => {
      expect(resolveRaw(envConfig.R2_S3_ENDPOINT, Mode.CiVitest)).toBe('http://minioapi.localhost');
      expect(resolveRaw(envConfig.R2_S3_ENDPOINT, Mode.E2E)).toBe('http://minioapi.localhost');
      expect(resolveRaw(envConfig.R2_S3_ENDPOINT, Mode.CiE2E)).toBe('http://minioapi.localhost');
    });

    it('is a secret in production', () => {
      const raw = resolveRaw(envConfig.R2_S3_ENDPOINT, Mode.Production);
      expect(isSecret(raw)).toBe(true);
    });
  });

  describe('R2_ACCESS_KEY_ID', () => {
    it('goes to Backend only', () => {
      expect(envConfig.R2_ACCESS_KEY_ID.to).toEqual([Destination.Backend]);
    });

    it('has MinIO default for development', () => {
      expect(resolveRaw(envConfig.R2_ACCESS_KEY_ID, Mode.Development)).toBe('minioadmin');
    });

    it('is a secret in production', () => {
      const raw = resolveRaw(envConfig.R2_ACCESS_KEY_ID, Mode.Production);
      expect(isSecret(raw)).toBe(true);
    });
  });

  describe('R2_SECRET_ACCESS_KEY', () => {
    it('goes to Backend only', () => {
      expect(envConfig.R2_SECRET_ACCESS_KEY.to).toEqual([Destination.Backend]);
    });

    it('has MinIO default for development', () => {
      expect(resolveRaw(envConfig.R2_SECRET_ACCESS_KEY, Mode.Development)).toBe('minioadmin');
    });

    it('is a secret in production', () => {
      const raw = resolveRaw(envConfig.R2_SECRET_ACCESS_KEY, Mode.Production);
      expect(isSecret(raw)).toBe(true);
    });
  });

  describe('R2_BUCKET_MEDIA', () => {
    it('goes to Backend only in production', () => {
      expect(getDestinations(envConfig.R2_BUCKET_MEDIA, Mode.Production)).toEqual([
        Destination.Backend,
      ]);
    });

    // The bring-up creates the bucket and the compose file names it, and both
    // read the scripts file — so the local modes carry it there as well as to
    // the Worker that writes the objects.
    it.each([Mode.Development, Mode.Test, Mode.CiVitest, Mode.E2E, Mode.CiE2E])(
      'reaches the scripts lane as well as the backend in %s',
      (mode) => {
        expect(getDestinations(envConfig.R2_BUCKET_MEDIA, mode)).toEqual([
          Destination.Backend,
          Destination.Scripts,
        ]);
      }
    );

    // It MUST ask for the stack's own bucket rather than name one, exactly as
    // the local Postgres URLs ask for the stack's own database: a name written
    // here would be a second spelling of the stack's identity, and the buckets
    // are what keep one stack's objects out of another's reach.
    it.each([Mode.Development, Mode.Test, Mode.CiVitest, Mode.E2E, Mode.CiE2E])(
      'asks for the stack own bucket in %s',
      (mode) => {
        expect(resolveRaw(envConfig.R2_BUCKET_MEDIA, mode)).toBe(STACK_BUCKET_MARKER);
      }
    );

    it('has production bucket name as a literal (not a secret)', () => {
      const raw = resolveRaw(envConfig.R2_BUCKET_MEDIA, Mode.Production);
      expect(isSecret(raw)).toBe(false);
      expect(raw).toBe('hushbox-media');
    });
  });

  describe('R2_ADMIN_ACCESS_KEY_ID', () => {
    it('goes to the Ops lane only (never the runtime Worker)', () => {
      expect(envConfig.R2_ADMIN_ACCESS_KEY_ID.to).toEqual([Destination.Ops]);
    });

    it('has MinIO default for development', () => {
      expect(resolveRaw(envConfig.R2_ADMIN_ACCESS_KEY_ID, Mode.Development)).toBe('minioadmin');
    });

    it('is the R2_ADMIN_ACCESS_KEY_ID secret in production', () => {
      const raw = resolveRaw(envConfig.R2_ADMIN_ACCESS_KEY_ID, Mode.Production);
      expect(isSecret(raw)).toBe(true);
      expect(isSecret(raw) && raw.name).toBe('R2_ADMIN_ACCESS_KEY_ID');
    });
  });

  describe('R2_ADMIN_SECRET_ACCESS_KEY', () => {
    it('goes to the Ops lane only (never the runtime Worker)', () => {
      expect(envConfig.R2_ADMIN_SECRET_ACCESS_KEY.to).toEqual([Destination.Ops]);
    });

    it('has MinIO default for development', () => {
      expect(resolveRaw(envConfig.R2_ADMIN_SECRET_ACCESS_KEY, Mode.Development)).toBe('minioadmin');
    });

    it('is the R2_ADMIN_SECRET_ACCESS_KEY secret in production', () => {
      const raw = resolveRaw(envConfig.R2_ADMIN_SECRET_ACCESS_KEY, Mode.Production);
      expect(isSecret(raw)).toBe(true);
      expect(isSecret(raw) && raw.name).toBe('R2_ADMIN_SECRET_ACCESS_KEY');
    });
  });

  describe('admin R2 credentials never reach the runtime Worker', () => {
    it('omits R2_ADMIN_* from the backend env schema', () => {
      expect('R2_ADMIN_ACCESS_KEY_ID' in backendEnvSchema.shape).toBe(false);
      expect('R2_ADMIN_SECRET_ACCESS_KEY' in backendEnvSchema.shape).toBe(false);
    });
  });

  describe('RATE_LIMIT_REDIS_TIMEOUT_MS', () => {
    it('goes to Backend only', () => {
      expect(envConfig.RATE_LIMIT_REDIS_TIMEOUT_MS.to).toEqual([Destination.Backend]);
    });

    it('bounds a production Redis round trip at 500 ms', () => {
      expect(resolveRaw(envConfig.RATE_LIMIT_REDIS_TIMEOUT_MS, Mode.Production)).toBe('500');
    });

    it('gives both E2E modes the loose Development bound', () => {
      const dev = resolveRaw(envConfig.RATE_LIMIT_REDIS_TIMEOUT_MS, Mode.Development);
      expect(resolveRaw(envConfig.RATE_LIMIT_REDIS_TIMEOUT_MS, Mode.E2E)).toBe(dev);
      expect(resolveRaw(envConfig.RATE_LIMIT_REDIS_TIMEOUT_MS, Mode.CiE2E)).toBe(dev);
    });

    it('leaves Development and CiVitest at the loose 5000 ms bound', () => {
      expect(resolveRaw(envConfig.RATE_LIMIT_REDIS_TIMEOUT_MS, Mode.Development)).toBe('5000');
      expect(resolveRaw(envConfig.RATE_LIMIT_REDIS_TIMEOUT_MS, Mode.CiVitest)).toBe('5000');
    });
  });

  describe('RATE_LIMIT_KEY_SECRET', () => {
    it('goes to Backend only', () => {
      expect(envConfig.RATE_LIMIT_KEY_SECRET.to).toEqual([Destination.Backend]);
    });

    it('is the RATE_LIMIT_KEY_SECRET secret in production', () => {
      const raw = resolveRaw(envConfig.RATE_LIMIT_KEY_SECRET, Mode.Production);
      expect(isSecret(raw)).toBe(true);
      expect(isSecret(raw) && raw.name).toBe('RATE_LIMIT_KEY_SECRET');
    });

    it('gives every non-production mode the Development key', () => {
      const dev = resolveRaw(envConfig.RATE_LIMIT_KEY_SECRET, Mode.Development);
      expect(typeof dev === 'string' && dev.length > 0).toBe(true);
      for (const mode of [Mode.Test, Mode.CiVitest, Mode.E2E, Mode.CiE2E]) {
        expect(resolveRaw(envConfig.RATE_LIMIT_KEY_SECRET, mode)).toBe(dev);
      }
    });
  });

  describe('OPAQUE_KEK', () => {
    it('goes to Backend only', () => {
      expect(envConfig.OPAQUE_KEK.to).toEqual([Destination.Backend]);
    });

    it('has a development literal of at least 32 characters', () => {
      const raw = resolveRaw(envConfig.OPAQUE_KEK, Mode.Development);
      expect(typeof raw === 'string' && raw.length >= 32).toBe(true);
    });

    it('refs the development literal in CiVitest, E2E, and CiE2E', () => {
      const dev = resolveRaw(envConfig.OPAQUE_KEK, Mode.Development);
      expect(resolveRaw(envConfig.OPAQUE_KEK, Mode.CiVitest)).toBe(dev);
      expect(resolveRaw(envConfig.OPAQUE_KEK, Mode.E2E)).toBe(dev);
      expect(resolveRaw(envConfig.OPAQUE_KEK, Mode.CiE2E)).toBe(dev);
    });

    it('is the OPAQUE_KEK secret in production', () => {
      const raw = resolveRaw(envConfig.OPAQUE_KEK, Mode.Production);
      expect(isSecret(raw)).toBe(true);
      expect(isSecret(raw) && raw.name).toBe('OPAQUE_KEK');
    });
  });

  describe('TOTP_ENCRYPTION_SECRET', () => {
    it('goes to Backend only', () => {
      expect(envConfig.TOTP_ENCRYPTION_SECRET.to).toEqual([Destination.Backend]);
    });

    it('has a development literal of at least 32 characters', () => {
      const raw = resolveRaw(envConfig.TOTP_ENCRYPTION_SECRET, Mode.Development);
      expect(typeof raw === 'string' && raw.length >= 32).toBe(true);
    });

    it('refs the development literal in CiVitest, E2E, and CiE2E', () => {
      const dev = resolveRaw(envConfig.TOTP_ENCRYPTION_SECRET, Mode.Development);
      expect(resolveRaw(envConfig.TOTP_ENCRYPTION_SECRET, Mode.CiVitest)).toBe(dev);
      expect(resolveRaw(envConfig.TOTP_ENCRYPTION_SECRET, Mode.E2E)).toBe(dev);
      expect(resolveRaw(envConfig.TOTP_ENCRYPTION_SECRET, Mode.CiE2E)).toBe(dev);
    });

    it('is the TOTP_ENCRYPTION_SECRET secret in production', () => {
      const raw = resolveRaw(envConfig.TOTP_ENCRYPTION_SECRET, Mode.Production);
      expect(isSecret(raw)).toBe(true);
      expect(isSecret(raw) && raw.name).toBe('TOTP_ENCRYPTION_SECRET');
    });
  });

  describe('ENUMERATION_DECOY_SECRET', () => {
    it('goes to Backend only', () => {
      expect(envConfig.ENUMERATION_DECOY_SECRET.to).toEqual([Destination.Backend]);
    });

    it('has a development literal of at least 32 characters', () => {
      const raw = resolveRaw(envConfig.ENUMERATION_DECOY_SECRET, Mode.Development);
      expect(typeof raw === 'string' && raw.length >= 32).toBe(true);
    });

    it('refs the development literal in CiVitest, E2E, and CiE2E', () => {
      const dev = resolveRaw(envConfig.ENUMERATION_DECOY_SECRET, Mode.Development);
      expect(resolveRaw(envConfig.ENUMERATION_DECOY_SECRET, Mode.CiVitest)).toBe(dev);
      expect(resolveRaw(envConfig.ENUMERATION_DECOY_SECRET, Mode.E2E)).toBe(dev);
      expect(resolveRaw(envConfig.ENUMERATION_DECOY_SECRET, Mode.CiE2E)).toBe(dev);
    });

    it('is the ENUMERATION_DECOY_SECRET secret in production', () => {
      const raw = resolveRaw(envConfig.ENUMERATION_DECOY_SECRET, Mode.Production);
      expect(isSecret(raw)).toBe(true);
      expect(isSecret(raw) && raw.name).toBe('ENUMERATION_DECOY_SECRET');
    });
  });

  describe('OPAQUE_KEK_NEXT', () => {
    it('goes to the Ops lane only (never the runtime Worker)', () => {
      expect(envConfig.OPAQUE_KEK_NEXT.to).toEqual([Destination.Ops]);
    });

    it('has a development literal', () => {
      const raw = resolveRaw(envConfig.OPAQUE_KEK_NEXT, Mode.Development);
      expect(typeof raw === 'string' && raw.length > 0).toBe(true);
    });

    it('is the OPAQUE_KEK_NEXT secret in production', () => {
      const raw = resolveRaw(envConfig.OPAQUE_KEK_NEXT, Mode.Production);
      expect(isSecret(raw)).toBe(true);
      expect(isSecret(raw) && raw.name).toBe('OPAQUE_KEK_NEXT');
    });

    it('is omitted from the backend env schema', () => {
      expect('OPAQUE_KEK_NEXT' in backendEnvSchema.shape).toBe(false);
    });
  });

  describe('TOTP_ENCRYPTION_SECRET_NEXT', () => {
    it('goes to the Ops lane only (never the runtime Worker)', () => {
      expect(envConfig.TOTP_ENCRYPTION_SECRET_NEXT.to).toEqual([Destination.Ops]);
    });

    it('has a development literal', () => {
      const raw = resolveRaw(envConfig.TOTP_ENCRYPTION_SECRET_NEXT, Mode.Development);
      expect(typeof raw === 'string' && raw.length > 0).toBe(true);
    });

    it('is the TOTP_ENCRYPTION_SECRET_NEXT secret in production', () => {
      const raw = resolveRaw(envConfig.TOTP_ENCRYPTION_SECRET_NEXT, Mode.Production);
      expect(isSecret(raw)).toBe(true);
      expect(isSecret(raw) && raw.name).toBe('TOTP_ENCRYPTION_SECRET_NEXT');
    });

    it('is omitted from the backend env schema', () => {
      expect('TOTP_ENCRYPTION_SECRET_NEXT' in backendEnvSchema.shape).toBe(false);
    });

    it('declares the same family as the key it replaces', () => {
      expect(envConfig.TOTP_ENCRYPTION_SECRET_NEXT.credential.family).toBe(
        envConfig.TOTP_ENCRYPTION_SECRET.credential.family
      );
    });
  });

  describe('the split identity secrets', () => {
    it('carry pairwise-distinct development literals', () => {
      const literals = [
        resolveRaw(envConfig.OPAQUE_KEK, Mode.Development),
        resolveRaw(envConfig.OPAQUE_KEK_NEXT, Mode.Development),
        resolveRaw(envConfig.TOTP_ENCRYPTION_SECRET, Mode.Development),
        resolveRaw(envConfig.TOTP_ENCRYPTION_SECRET_NEXT, Mode.Development),
        resolveRaw(envConfig.ENUMERATION_DECOY_SECRET, Mode.Development),
      ];
      expect(new Set(literals).size).toBe(literals.length);
    });

    it('replace OPAQUE_MASTER_SECRET, which no longer exists in the registry', () => {
      expect('OPAQUE_MASTER_SECRET' in envConfig).toBe(false);
    });

    it('replace OPAQUE_MASTER_SECRET in the backend env schema', () => {
      expect('OPAQUE_MASTER_SECRET' in backendEnvSchema.shape).toBe(false);
    });
  });

  describe('TELEMETRY_SINKS', () => {
    it('goes to Backend only', () => {
      expect(envConfig.TELEMETRY_SINKS.to).toEqual([Destination.Backend]);
    });

    it('composes the console sink only in development', () => {
      expect(resolveRaw(envConfig.TELEMETRY_SINKS, Mode.Development)).toBe('console');
    });

    it('refs development for CiVitest, E2E, and CiE2E', () => {
      expect(resolveRaw(envConfig.TELEMETRY_SINKS, Mode.CiVitest)).toBe('console');
      expect(resolveRaw(envConfig.TELEMETRY_SINKS, Mode.E2E)).toBe('console');
      expect(resolveRaw(envConfig.TELEMETRY_SINKS, Mode.CiE2E)).toBe('console');
    });

    it('composes all sinks in production', () => {
      expect(resolveRaw(envConfig.TELEMETRY_SINKS, Mode.Production)).toBe('console,sentry');
    });
  });

  describe('SENTRY_DSN', () => {
    it('goes to Backend only', () => {
      expect(envConfig.SENTRY_DSN.to).toEqual([Destination.Backend]);
    });

    it('is explicitly empty (disabled) in development', () => {
      expect(resolveRaw(envConfig.SENTRY_DSN, Mode.Development)).toBe('');
    });

    it('refs the disabled development value for CiVitest, E2E, and CiE2E', () => {
      expect(resolveRaw(envConfig.SENTRY_DSN, Mode.CiVitest)).toBe('');
      expect(resolveRaw(envConfig.SENTRY_DSN, Mode.E2E)).toBe('');
      expect(resolveRaw(envConfig.SENTRY_DSN, Mode.CiE2E)).toBe('');
    });

    it('is a secret in production', () => {
      const raw = resolveRaw(envConfig.SENTRY_DSN, Mode.Production);
      expect(isSecret(raw)).toBe(true);
    });
  });

  describe('MIGRATION_DATABASE_URL', () => {
    it('goes to Scripts only', () => {
      expect(envConfig.MIGRATION_DATABASE_URL.to).toEqual([Destination.Scripts]);
    });

    it('has development value', () => {
      expect(resolveRaw(envConfig.MIGRATION_DATABASE_URL, Mode.Development)).toContain(
        'postgresql://'
      );
    });

    it('is available in CI environments via ref', () => {
      expect(resolveRaw(envConfig.MIGRATION_DATABASE_URL, Mode.CiVitest)).toBeDefined();
      expect(resolveRaw(envConfig.MIGRATION_DATABASE_URL, Mode.E2E)).toBeDefined();
    });

    it('is not set in production (scripts not deployed)', () => {
      expect(resolveRaw(envConfig.MIGRATION_DATABASE_URL, Mode.Production)).toBeUndefined();
    });
  });

  describe('E2E_HEAP_PROBE', () => {
    const STACK_MODES = [Mode.Development, Mode.Test, Mode.CiVitest, Mode.E2E, Mode.CiE2E] as const;

    it('goes to Scripts only', () => {
      expect(envConfig.E2E_HEAP_PROBE.to).toEqual([Destination.Scripts]);
    });

    it.each(STACK_MODES)('resolves to an arm the reporter accepts in %s', (mode) => {
      expect(['on', 'off']).toContain(resolveRaw(envConfig.E2E_HEAP_PROBE, mode));
    });

    it('is not set in production (the reporter runs no stack there)', () => {
      expect(resolveRaw(envConfig.E2E_HEAP_PROBE, Mode.Production)).toBeUndefined();
    });
  });
});

describe('UPSTASH_REDIS_REST_TOKEN', () => {
  const LOCAL_MODES = [Mode.Development, Mode.CiVitest, Mode.E2E, Mode.CiE2E] as const;

  it('gives every local stack its own bearer token', () => {
    const tokens = [Mode.Development, Mode.CiVitest, Mode.E2E].map((mode) =>
      resolveRaw(envConfig.UPSTASH_REDIS_REST_TOKEN, mode)
    );

    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it('reaches the one local endpoint from every mode, so the token is what isolates', () => {
    const urls = LOCAL_MODES.map((mode) => resolveRaw(envConfig.UPSTASH_REDIS_REST_URL, mode));

    expect(new Set(urls).size).toBe(1);
  });

  it('runs the CI end-to-end stack on the same token as the local one', () => {
    expect(resolveRaw(envConfig.UPSTASH_REDIS_REST_TOKEN, Mode.CiE2E)).toBe(
      resolveRaw(envConfig.UPSTASH_REDIS_REST_TOKEN, Mode.E2E)
    );
  });
});

describe('backendEnvSchema', () => {
  it('validates correct development environment', () => {
    const validEnv = {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://localhost:5432/test',
      API_URL: 'http://localhost:8787',
      FRONTEND_URL: 'http://localhost:5173',
      MARKETING_URL: 'http://localhost:4321',
      ADMIN_URL: 'http://localhost:7000',
      APP_VERSION: 'dev-local',
      UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
      UPSTASH_REDIS_REST_TOKEN: 'local_dev_token',
      OPAQUE_KEK: 'dev-opaque-kek-32-bytes-minimum-literal', // gitleaks:allow
      TOTP_ENCRYPTION_SECRET: 'dev-totp-encryption-secret-32-bytes-min', // gitleaks:allow
      ENUMERATION_DECOY_SECRET: 'dev-enumeration-decoy-secret-32-bytes', // gitleaks:allow
      IRON_SESSION_SECRET: 'dev-iron-session-secret-32-bytes-min', // gitleaks:allow
      NOTIFICATION_TAG_SECRET: 'dev-notification-tag-hmac-key', // gitleaks:allow
    };

    const result = backendEnvSchema.safeParse(validEnv);
    expect(result.success).toBe(true);
  });

  it('validates correct production environment', () => {
    const validEnv = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://neon.tech:5432/prod',
      API_URL: 'https://api.hushbox.ai',
      FRONTEND_URL: 'https://hushbox.ai',
      MARKETING_URL: 'https://hushbox.ai',
      ADMIN_URL: 'https://admin.hushbox.ai',
      APP_VERSION: 'abc1234',
      RESEND_API_KEY: 're_123456789',
      HELCIM_API_TOKEN: 'helcim-token',
      HELCIM_WEBHOOK_VERIFIER: 'webhook-verifier',
      UPSTASH_REDIS_REST_URL: 'https://upstash-redis.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'prod_token_value',
      OPAQUE_KEK: 'prod-opaque-kek-32-bytes-minimum-literal', // gitleaks:allow
      TOTP_ENCRYPTION_SECRET: 'prod-totp-encryption-secret-32-bytes-min', // gitleaks:allow
      ENUMERATION_DECOY_SECRET: 'prod-enumeration-decoy-secret-32-bytes', // gitleaks:allow
      IRON_SESSION_SECRET: 'prod-iron-session-secret-32-bytes-min', // gitleaks:allow
      NOTIFICATION_TAG_SECRET: 'prod-notification-tag-hmac-key', // gitleaks:allow
    };

    const result = backendEnvSchema.safeParse(validEnv);
    expect(result.success).toBe(true);
  });

  it('accepts R2 media storage vars when provided', () => {
    const validEnv = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://neon.tech:5432/prod',
      API_URL: 'https://api.hushbox.ai',
      FRONTEND_URL: 'https://hushbox.ai',
      MARKETING_URL: 'https://hushbox.ai',
      ADMIN_URL: 'https://admin.hushbox.ai',
      APP_VERSION: 'abc1234',
      UPSTASH_REDIS_REST_URL: 'https://upstash-redis.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'prod_token_value',
      OPAQUE_KEK: 'prod-opaque-kek-32-bytes-minimum-literal', // gitleaks:allow
      TOTP_ENCRYPTION_SECRET: 'prod-totp-encryption-secret-32-bytes-min', // gitleaks:allow
      ENUMERATION_DECOY_SECRET: 'prod-enumeration-decoy-secret-32-bytes', // gitleaks:allow
      IRON_SESSION_SECRET: 'prod-iron-session-secret-32-bytes-min', // gitleaks:allow
      NOTIFICATION_TAG_SECRET: 'prod-notification-tag-hmac-key', // gitleaks:allow
      R2_S3_ENDPOINT: 'https://abc123.r2.cloudflarestorage.com',
      R2_ACCESS_KEY_ID: 'r2-access-key',
      R2_SECRET_ACCESS_KEY: 'r2-secret-key',
      R2_BUCKET_MEDIA: 'hushbox-media',
    };

    const result = backendEnvSchema.safeParse(validEnv);
    expect(result.success).toBe(true);
  });

  it('rejects invalid NODE_ENV', () => {
    const invalidEnv = {
      NODE_ENV: 'invalid',
      DATABASE_URL: 'postgres://localhost:5432/test',
      API_URL: 'http://localhost:8787',
      FRONTEND_URL: 'http://localhost:5173',
      UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
      UPSTASH_REDIS_REST_TOKEN: 'local_dev_token',
      OPAQUE_KEK: 'dev-opaque-kek-32-bytes-minimum-literal', // gitleaks:allow
      TOTP_ENCRYPTION_SECRET: 'dev-totp-encryption-secret-32-bytes-min', // gitleaks:allow
      ENUMERATION_DECOY_SECRET: 'dev-enumeration-decoy-secret-32-bytes', // gitleaks:allow
      IRON_SESSION_SECRET: 'dev-iron-session-secret-32-bytes-min', // gitleaks:allow
    };

    const result = backendEnvSchema.safeParse(invalidEnv);
    expect(result.success).toBe(false);
  });

  it('rejects missing ADMIN_URL', () => {
    const invalidEnv = {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://localhost:5432/test',
      API_URL: 'http://localhost:8787',
      FRONTEND_URL: 'http://localhost:5173',
      APP_VERSION: 'dev-local',
      UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
      UPSTASH_REDIS_REST_TOKEN: 'local_dev_token',
      OPAQUE_KEK: 'dev-opaque-kek-32-bytes-minimum-literal', // gitleaks:allow
      TOTP_ENCRYPTION_SECRET: 'dev-totp-encryption-secret-32-bytes-min', // gitleaks:allow
      ENUMERATION_DECOY_SECRET: 'dev-enumeration-decoy-secret-32-bytes', // gitleaks:allow
      IRON_SESSION_SECRET: 'dev-iron-session-secret-32-bytes-min', // gitleaks:allow
    };

    const result = backendEnvSchema.safeParse(invalidEnv);
    expect(result.success).toBe(false);
  });

  it('rejects missing DATABASE_URL', () => {
    const invalidEnv = {
      NODE_ENV: 'development',
      API_URL: 'http://localhost:8787',
      FRONTEND_URL: 'http://localhost:5173',
      UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
      UPSTASH_REDIS_REST_TOKEN: 'local_dev_token',
      OPAQUE_KEK: 'dev-opaque-kek-32-bytes-minimum-literal', // gitleaks:allow
      TOTP_ENCRYPTION_SECRET: 'dev-totp-encryption-secret-32-bytes-min', // gitleaks:allow
      ENUMERATION_DECOY_SECRET: 'dev-enumeration-decoy-secret-32-bytes', // gitleaks:allow
      IRON_SESSION_SECRET: 'dev-iron-session-secret-32-bytes-min', // gitleaks:allow
    };

    const result = backendEnvSchema.safeParse(invalidEnv);
    expect(result.success).toBe(false);
  });

  it.each(['OPAQUE_KEK', 'TOTP_ENCRYPTION_SECRET', 'ENUMERATION_DECOY_SECRET'])(
    'rejects %s shorter than 32 characters',
    (name) => {
      const env = {
        NODE_ENV: 'development',
        DATABASE_URL: 'postgres://localhost:5432/test',
        API_URL: 'http://localhost:8787',
        FRONTEND_URL: 'http://localhost:5173',
        MARKETING_URL: 'http://localhost:4321',
        ADMIN_URL: 'http://localhost:7000',
        APP_VERSION: 'dev-local',
        UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
        UPSTASH_REDIS_REST_TOKEN: 'local_dev_token',
        OPAQUE_KEK: 'dev-opaque-kek-32-bytes-minimum-literal', // gitleaks:allow
        TOTP_ENCRYPTION_SECRET: 'dev-totp-encryption-secret-32-bytes-min', // gitleaks:allow
        ENUMERATION_DECOY_SECRET: 'dev-enumeration-decoy-secret-32-bytes', // gitleaks:allow
        IRON_SESSION_SECRET: 'dev-iron-session-secret-32-bytes-min', // gitleaks:allow
        NOTIFICATION_TAG_SECRET: 'dev-notification-tag-hmac-key', // gitleaks:allow
        [name]: 'short',
      };

      const result = backendEnvSchema.safeParse(env);
      expect(result.success).toBe(false);
    }
  );

  it('allows CI/prod secrets to be optional', () => {
    const validEnv = {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://localhost:5432/test',
      API_URL: 'http://localhost:8787',
      FRONTEND_URL: 'http://localhost:5173',
      MARKETING_URL: 'http://localhost:4321',
      ADMIN_URL: 'http://localhost:7000',
      APP_VERSION: 'dev-local',
      UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
      UPSTASH_REDIS_REST_TOKEN: 'local_dev_token',
      OPAQUE_KEK: 'dev-opaque-kek-32-bytes-minimum-literal', // gitleaks:allow
      TOTP_ENCRYPTION_SECRET: 'dev-totp-encryption-secret-32-bytes-min', // gitleaks:allow
      ENUMERATION_DECOY_SECRET: 'dev-enumeration-decoy-secret-32-bytes', // gitleaks:allow
      IRON_SESSION_SECRET: 'dev-iron-session-secret-32-bytes-min', // gitleaks:allow
      // Required in every mode, so it stays even here (see the schema comment).
      NOTIFICATION_TAG_SECRET: 'dev-notification-tag-hmac-key', // gitleaks:allow
      // CI/prod secrets are omitted - test they're optional
    };

    const result = backendEnvSchema.safeParse(validEnv);
    expect(result.success).toBe(true);
  });

  describe('credential declarations', () => {
    const entries = Object.entries<VariableConfig>(envConfig);

    it('are carried by every entry holding a secret marker in any mode', () => {
      const undeclared = entries
        .filter(([, config]) => isAnyModeSecret(config) && config.credential === undefined)
        .map(([name]) => name);
      expect(undeclared).toEqual([]);
    });

    it('are absent from every entry holding no secret marker', () => {
      const declared = entries
        .filter(([, config]) => !isAnyModeSecret(config) && config.credential !== undefined)
        .map(([name]) => name);
      expect(declared).toEqual([]);
    });

    it('carry prose in description and userVisible', () => {
      for (const [, config] of entries) {
        if (config.credential === undefined) continue;
        expect(config.credential.description.trim()).not.toBe('');
        expect(config.credential.userVisible.trim()).not.toBe('');
      }
    });
  });
});

/**
 * The modes one entry's resolution visits, in order: the mode asked for, then
 * wherever each `ref` sends it next.
 */
function modesVisited(config: VariableConfig, mode: EnvMode): EnvMode[] {
  const raw = getModeValue(config, mode);
  return isRef(raw) ? [mode, ...modesVisited(config, raw.env)] : [mode];
}

/** The modes a continuous-integration runner sets, read off the mode table's own spelling. */
const CI_MODES: EnvMode[] = Object.values(Mode).filter((mode) => mode.startsWith('ci'));

describe('the local mode of the test stack', () => {
  const entries = Object.entries<VariableConfig>(envConfig);

  it('carries a value for every entry both the development and the CI vitest mode carry one for', () => {
    const missing = entries
      .filter(
        ([, config]) =>
          resolveRaw(config, Mode.Development) !== undefined &&
          resolveRaw(config, Mode.CiVitest) !== undefined &&
          resolveRaw(config, Mode.Test) === undefined
      )
      .map(([name]) => name);

    expect(missing).toEqual([]);
  });

  it('reaches no secret, so a machine holding no CI credential resolves it whole', () => {
    const reaching = entries
      .filter(([, config]) => isSecret(resolveRaw(config, Mode.Test)))
      .map(([name]) => name);

    expect(reaching).toEqual([]);
  });

  it('selects the same Redis pool as the CI mode of the same stack, and not the development one', () => {
    const local = resolveRaw(envConfig.UPSTASH_REDIS_REST_TOKEN, Mode.Test);

    expect(local).toBe(resolveRaw(envConfig.UPSTASH_REDIS_REST_TOKEN, Mode.CiVitest));
    expect(local).not.toBe(resolveRaw(envConfig.UPSTASH_REDIS_REST_TOKEN, Mode.Development));
  });

  it('leaves the CI mode of the same stack reaching secrets no local machine holds', () => {
    const reaching = entries
      .filter(([, config]) => isSecret(resolveRaw(config, Mode.CiVitest)))
      .map(([name]) => name);

    expect(reaching.length).toBeGreaterThan(0);
  });

  it('still reads the modes of continuous integration off the mode table', () => {
    expect(
      CI_MODES,
      'the case below walks the resolution of every entry looking for one of these, so a set that no longer holds them asserts nothing'
    ).toEqual(expect.arrayContaining([Mode.CiVitest, Mode.CiE2E]));
  });

  it('resolves every value without walking into a mode of continuous integration', () => {
    const walking = entries
      .filter(([, config]) =>
        modesVisited(config, Mode.Test).some((visited) => CI_MODES.includes(visited))
      )
      .map(([name]) => name);

    expect(
      walking,
      'a local run resolving a value out of a CI mode is a local run reading the CI variables. Where the two modes share a value, spell it on this one and have the CI mode reference it'
    ).toEqual([]);
  });
});
