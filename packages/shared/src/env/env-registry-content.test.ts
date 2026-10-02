import { readFileSync } from 'node:fs';

import { describe, it, expect } from 'vitest';
import {
  Destination,
  Mode,
  envConfig,
  resolveRaw,
  secret,
  type VariableConfig,
} from './env.config.ts';
import { envRegistryContentIn } from './env-registry-content.ts';

/** The literal a development mode carries, fail-fast when the entry stops carrying one. */
function developmentLiteral(config: VariableConfig): string {
  const value = resolveRaw(config, Mode.Development);
  if (typeof value !== 'string') throw new Error('entry carries no development literal');
  return value;
}

describe('envRegistryContentIn', () => {
  it('flags a registry entry declaration in minified bundler output', () => {
    const source = 'x={OPAQUE_KEK:{to:[H.Backend],[U.Development]:`placeholder`}}';
    expect(envRegistryContentIn(source)).toContain('OPAQUE_KEK');
  });

  it('flags a registry entry declaration in unminified bundler output', () => {
    const source = 'const c = {\n\tIRON_SESSION_SECRET: {\n\t\tto: [Destination.Backend]\n\t}\n};';
    expect(envRegistryContentIn(source)).toContain('IRON_SESSION_SECRET');
  });

  it('leaves a registry name mentioned outside a declaration unflagged', () => {
    const source = 'function CI(){} var _process$env$NODE_ENV; const t = "Case_Ignorable CI";';
    expect(envRegistryContentIn(source)).toEqual([]);
  });

  it('leaves an artifact carrying no registry unflagged', () => {
    expect(envRegistryContentIn('"use strict";(()=>{console.log(1)})();')).toEqual([]);
  });

  it("flags a credential-bearing entry's placeholder value on its own", () => {
    const placeholder = resolveRaw(envConfig.OPAQUE_KEK, Mode.Development);
    const source = `const k = ${JSON.stringify(placeholder)};`;
    expect(envRegistryContentIn(source)).toContain('OPAQUE_KEK value');
  });

  /**
   * The `secret(...)` marker is per-mode, so an entry can hold a credential in a CI
   * mode alone and carry no production value at all. Reading the marker in
   * production only would leave that entry's stand-in literal out of the needle
   * set — and this tier is the fallback for output the declaration pattern no
   * longer recognises, which is the shape a values-only inline slips through.
   */
  it('flags the placeholder of an entry whose secret marker sits in a CI mode alone', () => {
    const registry = {
      ALPHA_TOKEN: {
        to: [Destination.Backend],
        [Mode.Development]: 'alpha-development-stand-in',
        [Mode.CiVitest]: secret('ALPHA_TOKEN'),
      },
    } satisfies Record<string, VariableConfig>;
    expect(envRegistryContentIn('const k = "alpha-development-stand-in";', registry)).toEqual([
      'ALPHA_TOKEN value',
    ]);
  });

  /** The gate stays a credential gate: a backend entry holding no secret in any mode
   * carries an ordinary literal, and matching those would report every artifact. */
  it('leaves the literal of an entry that carries no credential unflagged', () => {
    const registry = {
      ALPHA_URL: { to: [Destination.Backend], [Mode.Development]: 'alpha-development-literal' },
    } satisfies Record<string, VariableConfig>;
    expect(envRegistryContentIn('const u = "alpha-development-literal";', registry)).toEqual([]);
  });

  /**
   * A stand-in that is nothing but an origin on a loopback host names no host
   * another machine can reach, no account and no credential, so it fails the
   * premise this tier rests on — that such a literal exists nowhere else. Two
   * live entries carry one, and the web dist's `_headers` names one of them in
   * every dev-mode `connect-src` it writes, which is a public emulator origin
   * rather than anything the registry identifies.
   */
  it('leaves a stand-in that is nothing but a loopback origin unflagged', () => {
    const registry = {
      ALPHA_ENDPOINT: {
        to: [Destination.Backend],
        [Mode.Development]: 'http://localhost:9000',
        [Mode.Production]: secret('ALPHA_ENDPOINT'),
      },
    } satisfies Record<string, VariableConfig>;
    expect(envRegistryContentIn("connect-src 'self' http://localhost:9000;", registry)).toEqual([]);
  });

  /**
   * The live entries the tier above describes, read from the registry itself.
   * Their stand-ins name a local-stack service in host position, and `URL`
   * lowercases a hostname — so a host spelled with a capital no longer equals
   * its own origin, the exemption stops applying, and a credential-free
   * emulator address becomes a needle every dev-mode `_headers` trips.
   */
  it('leaves the live local-stack stand-ins unflagged', () => {
    const standIns = [
      developmentLiteral(envConfig.UPSTASH_REDIS_REST_URL),
      developmentLiteral(envConfig.R2_S3_ENDPOINT),
    ];

    expect(envRegistryContentIn(`connect-src 'self' ${standIns.join(' ')};`)).toEqual([]);
  });

  /** Loopback is not the property: userinfo, a path, a query or a fragment all
   * carry material an origin does not, and the live database entries are exactly
   * that shape. */
  it('flags a loopback stand-in that carries more than an origin', () => {
    const registry = {
      ALPHA_DATABASE_URL: {
        to: [Destination.Backend],
        [Mode.Development]: 'postgres://alpha:alpha@localhost:5432/alpha',
        [Mode.Production]: secret('ALPHA_DATABASE_URL'),
      },
    } satisfies Record<string, VariableConfig>;
    const source = 'const u = "postgres://alpha:alpha@localhost:5432/alpha";';
    expect(envRegistryContentIn(source, registry)).toEqual(['ALPHA_DATABASE_URL value']);
  });

  /** Nor is origin shape the property: an origin on a routable host names a
   * remote service, and a tenant-shaped one identifies the account it belongs to. */
  it('flags a bare-origin stand-in on a host that is not loopback', () => {
    const registry = {
      ALPHA_REST_URL: {
        to: [Destination.Backend],
        [Mode.Development]: 'https://alpha-tenant-31402.example.io',
        [Mode.Production]: secret('ALPHA_REST_URL'),
      },
    } satisfies Record<string, VariableConfig>;
    const source = 'const u = "https://alpha-tenant-31402.example.io";';
    expect(envRegistryContentIn(source, registry)).toEqual(['ALPHA_REST_URL value']);
  });

  it('leaves a placeholder value that only prefixes a longer identifier unflagged', () => {
    // A real shipped identifier begins with this slug: the web app's IndexedDB database name.
    const buried = `${developmentLiteral(envConfig.CF_ACCESS_TEAM_DOMAIN)}ice-key`;
    expect(envRegistryContentIn(`const DB_NAME = ${JSON.stringify(buried)};`)).toEqual([]);
  });

  it('flags that same placeholder value where it stands as a whole token', () => {
    const placeholder = developmentLiteral(envConfig.CF_ACCESS_TEAM_DOMAIN);
    expect(envRegistryContentIn(`x={d:${JSON.stringify(placeholder)}}`)).toContain(
      'CF_ACCESS_TEAM_DOMAIN value'
    );
  });

  it('flags a placeholder value that a longer identifier also merely prefixes', () => {
    const placeholder = developmentLiteral(envConfig.CF_ACCESS_TEAM_DOMAIN);
    const source = `${placeholder}ice-key = ${placeholder}`;
    expect(envRegistryContentIn(source)).toContain('CF_ACCESS_TEAM_DOMAIN value');
  });

  it('leaves a declaration whose name merely ends with an entry name unflagged', () => {
    const registry = {
      SHIPPED_ENTRY: { to: [Destination.Backend] },
      VITE_SHIPPED_ENTRY: { to: [Destination.Frontend], [Mode.Development]: 'shipped' },
    };
    expect(envRegistryContentIn('x={VITE_SHIPPED_ENTRY:{to:[0]}}', registry)).toEqual([]);
  });

  it('leaves a value a frontend entry also carries unflagged', () => {
    const shipped = resolveRaw(envConfig.VITE_VAPID_PUBLIC_KEY, Mode.Development);
    expect(envRegistryContentIn(`const k = ${JSON.stringify(shipped)};`)).toEqual([]);
  });

  const QUOTES = ['"', "'", '`'];

  /**
   * Which quote a build prints a string literal with is its own choice, and the
   * quotes differ between toolchains and between releases of one. A case per
   * quote the toolchains here happen to print would pin those printers; the
   * shape is every quote the language allows.
   */
  it.each(QUOTES)('flags a backend destination inlined as a string quoted with %s', (quote) => {
    expect(envRegistryContentIn(`x={to:[${quote}backend${quote}]}`)).toContain(
      'backend destination marker'
    );
  });

  /** Not valid JavaScript, so no build emits it: the pattern's two quotes must match. */
  it('leaves a to array whose opening and closing quotes differ unflagged', () => {
    expect(envRegistryContentIn('x={to:["backend\']}')).toEqual([]);
  });

  /** The shape esbuild emits: the table's binding minified, its property name kept. */
  it('flags a backend destination left as a read off the destination table', () => {
    expect(envRegistryContentIn('x={to:[$.Backend]}')).toContain('backend destination marker');
  });

  it.each(QUOTES)(
    'flags a backend destination read off the table by a key quoted with %s',
    (quote) => {
      expect(envRegistryContentIn(`x={to:[$[${quote}Backend${quote}]]}`)).toContain(
        'backend destination marker'
      );
    }
  );

  it('flags a backend destination that is not the first in its array', () => {
    expect(envRegistryContentIn('x={to:[$.Scripts,$.Backend]}')).toContain(
      'backend destination marker'
    );
  });

  it('leaves a declaration naming only the frontend destination unflagged', () => {
    expect(envRegistryContentIn('x={to:[$.Frontend]}')).toEqual([]);
  });

  /**
   * The needle and the shape the registry actually declares have to agree, and
   * every other case here supplies its own haystack — so a marker that stopped
   * matching anything the registry emits satisfies all of them. The registry
   * source is the one haystack this file does not write.
   */
  it('flags the destination declarations the registry source itself carries', () => {
    const source = readFileSync(new URL('env.config.ts', import.meta.url), 'utf8');
    expect(envRegistryContentIn(source)).toContain('backend destination marker');
  });

  it('covers an entry the registry gains without the guard being edited', () => {
    const registry = { NEWLY_ADDED_ENTRY: { to: [Destination.Backend] } };
    expect(envRegistryContentIn('x={NEWLY_ADDED_ENTRY:{to:[1]}}', registry)).toEqual([
      'NEWLY_ADDED_ENTRY',
    ]);
  });

  it('refuses a registry entry whose name is not an identifier', () => {
    const registry = { 'not-an-identifier': { to: [Destination.Backend] } };
    expect(() => envRegistryContentIn('', registry)).toThrow('not-an-identifier');
  });
});

/**
 * The registry object is one way its names reach an artifact; the Zod schema
 * restating a subset of those names is the other, and it carries none of the
 * shapes the declaration, placeholder and marker patterns read — a minifier
 * leaves it in key shapes of which `NAME:E().min(1)` is one. Names in
 * object-key position are all that leak shape has in common with the registry,
 * so that is what this tier matches.
 */
describe('envRegistryContentIn, backend names in key position', () => {
  /** Credential-bearing, so each entry is a needle of this tier. */
  function credentialEntries(names: readonly string[]): Record<string, VariableConfig> {
    return Object.fromEntries(
      names.map((name) => [
        name,
        { to: [Destination.Backend], [Mode.Production]: secret(name) } satisfies VariableConfig,
      ])
    );
  }

  it('reports the backend schema leaking as a cluster of names', () => {
    const leaked =
      'const S=He({UPSTASH_REDIS_REST_TOKEN:de().min(1),' +
      'OPAQUE_KEK:de().min(32),IRON_SESSION_SECRET:de().min(32)});';
    expect(envRegistryContentIn(leaked)).toEqual(
      expect.arrayContaining([
        'UPSTASH_REDIS_REST_TOKEN in key position',
        'OPAQUE_KEK in key position',
        'IRON_SESSION_SECRET in key position',
      ])
    );
  });

  it('leaves a lone backend name in key position unflagged', () => {
    const registry = credentialEntries(['ALPHA_TOKEN']);
    expect(envRegistryContentIn('x={ALPHA_TOKEN:1}', registry)).toEqual([]);
  });

  it('leaves two backend names in key position unflagged', () => {
    const registry = credentialEntries(['ALPHA_TOKEN', 'BETA_TOKEN']);
    expect(envRegistryContentIn('x={ALPHA_TOKEN:1,BETA_TOKEN:2}', registry)).toEqual([]);
  });

  it('reports three backend names in key position', () => {
    const registry = credentialEntries(['ALPHA_TOKEN', 'BETA_TOKEN', 'GAMMA_TOKEN']);
    expect(envRegistryContentIn('x={ALPHA_TOKEN:1,BETA_TOKEN:2,GAMMA_TOKEN:3}', registry)).toEqual([
      'ALPHA_TOKEN in key position',
      'BETA_TOKEN in key position',
      'GAMMA_TOKEN in key position',
    ]);
  });

  it('counts a name once however many times the artifact repeats it', () => {
    const registry = credentialEntries(['ALPHA_TOKEN', 'BETA_TOKEN']);
    const source = 'x={ALPHA_TOKEN:1,BETA_TOKEN:2};y={ALPHA_TOKEN:3,BETA_TOKEN:4}';
    expect(envRegistryContentIn(source, registry)).toEqual([]);
  });

  /**
   * `VITE_VAPID_PUBLIC_KEY` ships to the frontend and ends with the backend
   * `VAPID_PUBLIC_KEY`, so an unanchored match would count the frontend entry
   * as a backend one and push every artifact carrying it over the threshold.
   */
  it('does not count a frontend key that merely ends with a backend name', () => {
    const source = 'x={VITE_VAPID_PUBLIC_KEY:"k",OPAQUE_KEK:1,IRON_SESSION_SECRET:2}';
    expect(envRegistryContentIn(source)).toEqual([]);
  });

  it('counts that backend name where it stands as a key on its own', () => {
    const source = 'x={VAPID_PUBLIC_KEY:"k",OPAQUE_KEK:1,IRON_SESSION_SECRET:2}';
    expect(envRegistryContentIn(source)).toEqual(
      expect.arrayContaining(['VAPID_PUBLIC_KEY in key position'])
    );
  });

  it('does not count a longer key that merely begins with a backend name', () => {
    const registry = credentialEntries(['ALPHA_TOKEN', 'BETA_TOKEN', 'GAMMA_TOKEN']);
    const source = 'x={ALPHA_TOKEN_EXTRA:1,BETA_TOKEN:2,GAMMA_TOKEN:3}';
    expect(envRegistryContentIn(source, registry)).toEqual([]);
  });

  /** A name the declaration tier already named needs no second line about it. */
  it('reports a name the declaration tier already caught only once', () => {
    const registry = credentialEntries(['ALPHA_TOKEN', 'BETA_TOKEN', 'GAMMA_TOKEN']);
    const source = 'x={ALPHA_TOKEN:{to:[0]},BETA_TOKEN:2,GAMMA_TOKEN:3}';
    expect(envRegistryContentIn(source, registry)).toEqual([
      'ALPHA_TOKEN',
      'BETA_TOKEN in key position',
      'GAMMA_TOKEN in key position',
    ]);
  });

  /**
   * The frontend builds its env-utilities context out of backend registry
   * names — `NODE_ENV`, `CI` and `E2E` are the three registry-declared
   * `createEnvUtilities` reads — so those three in key position are the normal
   * shape of a browser bundle. None of them is credential-bearing, which is
   * what keeps this tier silent on them.
   */
  it('leaves the frontend env-utilities context unflagged', () => {
    const source = 'Te=s({NODE_ENV:`production`,...K?{CI:K}:{},...q?{E2E:q}:{}})';
    expect(envRegistryContentIn(source)).toEqual([]);
  });

  /**
   * The `secret(...)` marker is per-mode, so an entry can hold a credential in
   * one mode and have no production value at all. Reading the marker in
   * production alone would leave such an entry out of the needle set.
   */
  it('counts an entry whose secret marker is in a CI mode alone', () => {
    const registry = {
      ...credentialEntries(['BETA_TOKEN', 'GAMMA_TOKEN']),
      ALPHA_TOKEN: { to: [Destination.Backend], [Mode.CiVitest]: secret('ALPHA_TOKEN') },
    } satisfies Record<string, VariableConfig>;
    expect(envRegistryContentIn('x={ALPHA_TOKEN:1,BETA_TOKEN:2,GAMMA_TOKEN:3}', registry)).toEqual(
      expect.arrayContaining(['ALPHA_TOKEN in key position'])
    );
  });

  /** The live registry already carries two such entries, both CI-only credentials. */
  it("counts the registry's CI-only credentials towards the cluster", () => {
    const source = 'x={FCM_PROJECT_ID_CI:1,FCM_SERVICE_ACCOUNT_JSON_CI:2,OPAQUE_KEK:3}';
    expect(envRegistryContentIn(source)).toEqual(
      expect.arrayContaining([
        'FCM_PROJECT_ID_CI in key position',
        'FCM_SERVICE_ACCOUNT_JSON_CI in key position',
      ])
    );
  });
});
