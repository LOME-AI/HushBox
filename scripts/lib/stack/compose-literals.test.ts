/**
 * No value in `docker-compose.yml` is a second spelling of one the environment
 * already owns.
 *
 * The subject is the derivation on both sides. The values are read out of the
 * environment registry and the compose-facing derivation beside it, so a
 * variable added to either is covered the moment it exists. The text is read by
 * one question asked of every scalar the document holds, values and mapping
 * keys alike — does this carry an owned value as a whole token. Nothing keys on
 * the shape a duplicate is written in, so a mapped environment entry, an entry
 * list, a command argument, a healthcheck probe, a mount and a key are covered
 * without one of them being named here.
 *
 * Every scalar is read twice, because compose's environment list form spells an
 * entry `NAME=value` and what the container receives is the text after the
 * first `=`. That is decoding compose's own syntax, not a second question.
 *
 * WHERE A SCALAR IS A NAME RATHER THAN A VALUE. Compose resolves some scalars
 * as references — the image a service runs, and the names its `depends_on`,
 * `links`, `volumes_from`, `network_mode`, `ipc`, `pid`, `networks` and
 * `extends.service` fields carry — and the keys of the mappings that declare or
 * refer to those. Which positions those are is compose's schema rather than a
 * reading of this file, and every other position is content. The default is
 * what makes that safe: a position compose grows later is read as content and
 * reported, never passed over.
 *
 * Position is the whole exemption. Nothing is read out of a scalar's text to
 * decide that part of it names something: the program a `command` runs and the
 * service a URI addresses are written as content and read as content, so an
 * owned value standing in either is reported. What stops that reporting a
 * legitimate use is the case demanding the environment own no value this file
 * declares as a name — one property held outright, where a reading of the text
 * held it one shape at a time and had to be widened for each new shape.
 *
 * WHAT IT REPORTS THAT IS NOT A DUPLICATE — the whole list, because a ruling
 * that a cost is acceptable is only as good as the list it was given:
 *
 * - A longer text carrying an owned value as a whole token. What continues a
 *   token is an identifier character or the hyphen, so every other character
 *   ends one: a dot, a slash, a colon, an equals or a space on each side of the
 *   value — or the end of the text — is enough to report the whole text. The
 *   domain `hushbox.ai` against a database named `hushbox` is that shape with
 *   dots, a path segment named after a bucket the same shape with slashes.
 * - An owned value that is an ordinary word rather than an identity. One the
 *   backend schema draws from a closed set is dropped, as a number is, but
 *   nothing declares the closed set behind every such value, and one that
 *   stands collides with any legitimate use of that word.
 * - A declared volume named after an owned value. Compose's short mount form
 *   puts a host path and a volume name in one scalar, and the mount named after
 *   a bucket has to be reported, so that field is read as content.
 *
 * WHAT IT CANNOT SEE. A duplicate written at one of the compose reference
 * positions above, or as a key of a mapping that declares names. Beyond those,
 * nothing numeric, nothing a `VITE_*` entry carries, and nothing outside this
 * file.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { Destination, Mode, getDestinations } from '@hushbox/shared';
import { includesAsToken } from '@hushbox/shared/env-registry-content';
import { backendEnvSchema, envConfig } from '@hushbox/shared/env.config';
import { COMPOSE_ENV_VARIABLES, composeEnvValues } from './compose-env.js';
import { STACK_BUCKET_LIST_VARIABLE, STACK_BUCKET_VARIABLES } from './stack-bucket.js';
import type { VariableConfig } from '@hushbox/shared';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

const COMPOSE_FILE = 'docker-compose.yml';

function composeSource(): string {
  return readFileSync(path.join(REPO_ROOT, COMPOSE_FILE), 'utf8');
}

/**
 * What continues a token here: identifier characters and the hyphen that
 * slug-shaped values are built from.
 *
 * Everything else separates — the dot, the slash, the colon, the equals, the
 * space — so an owned value standing whole anywhere inside a longer text is
 * reported: a file named after the bucket it seeds, a bucket used as the
 * leading label of a host, a directory named after either. A silent second
 * spelling defeats this gate outright where a reported innocent one costs a
 * substitution or a rename, so the reading goes this way; the header states
 * what it costs.
 */
const TOKEN_CHAR = /^[\w-]$/u;

/** Top-level mappings whose keys are the names this file declares. */
const DECLARATION_MAPS = new Set(['services', 'volumes', 'networks', 'configs', 'secrets']);

/** Service fields whose scalars name something compose resolves. */
const REFERENCE_FIELDS = new Set([
  'image',
  'depends_on',
  'links',
  'volumes_from',
  'network_mode',
  'ipc',
  'pid',
  'networks',
]);

/** Where a node sits in the document: mapping keys and list indices, in order. */
type Position = readonly (string | number)[];

/**
 * The text left once compose's own substitutions are taken out. A substitution
 * is the shape this file is asking for, so it is read as no spelling at all;
 * nesting is resolved by repeating until the text settles.
 *
 * That erasure is sound only because a substitution here cannot resolve to a
 * literal, and nothing in this file establishes it: `compose-file.test.ts`
 * demands a value for every substitution the compose file performs, which
 * leaves `${NAME:?message}` as the one admitted form. Lose that sibling and a
 * `${NAME:-a-bucket}` hands the container a literal this function has already
 * erased, with every case here still green.
 */
function withoutSubstitutions(text: string): string {
  let stripped = text;
  for (let next = stripped.replaceAll(/\$\{[^{}]*\}/gu, ''); next !== stripped; ) {
    stripped = next;
    next = stripped.replaceAll(/\$\{[^{}]*\}/gu, '');
  }
  return stripped;
}

function textOf(node: unknown): string | undefined {
  if (typeof node === 'string') return withoutSubstitutions(node);
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  return undefined;
}

/** A scalar compose resolves as a name — an image, a service, a network. */
function namesSomething(position: Position): boolean {
  if (position[0] !== 'services' || position.length < 3) return false;
  const field = position[2];
  if (field === 'extends') return position.length === 4 && position[3] === 'service';
  if (typeof field !== 'string' || !REFERENCE_FIELDS.has(field)) return false;
  return position.length === 3 || (position.length === 4 && typeof position[3] === 'number');
}

/** A mapping whose keys declare or refer to a name rather than carry content. */
function keysAreNames(position: Position): boolean {
  const field = position[2];
  if (position.length === 1) {
    return typeof position[0] === 'string' && DECLARATION_MAPS.has(position[0]);
  }
  return (
    position[0] === 'services' &&
    position.length === 3 &&
    (field === 'depends_on' || field === 'networks')
  );
}

/** Every scalar the document holds, keys included, bar the ones naming things. */
function scalarsIn(node: unknown, position: Position): string[] {
  const text = textOf(node);
  if (text !== undefined) return namesSomething(position) ? [] : [text];
  if (Array.isArray(node)) {
    return node.flatMap((item, index) => scalarsIn(item, [...position, index]));
  }
  if (node !== null && typeof node === 'object') {
    const named = keysAreNames(position);
    return Object.entries(node).flatMap(([key, value]) => [
      ...(named ? [] : [key]),
      ...scalarsIn(value, [...position, key]),
    ]);
  }
  return [];
}

/** Every name this file declares, in any of the mappings that declare one. */
function declaredNames(document: unknown): Set<string> {
  const names = new Set<string>();
  if (document === null || typeof document !== 'object') return names;
  for (const map of DECLARATION_MAPS) {
    const declarations = (document as Record<string, unknown>)[map];
    if (declarations === null || typeof declarations !== 'object') continue;
    for (const name of Object.keys(declarations)) names.add(name);
  }
  return names;
}

/**
 * The texts one scalar spells: itself, and — where it is written in compose's
 * `NAME=value` entry form — the value that form hands the container, which is
 * everything after the first `=`.
 *
 * Read off the text rather than off the key it sits under, so the entry form is
 * decoded wherever compose admits it and a scalar carrying no `=` yields the
 * one reading it has.
 */
function spellingsOf(text: string): string[] {
  const assignedValue = text.slice(text.indexOf('=') + 1);
  return assignedValue === text ? [text] : [text, assignedValue];
}

/**
 * Every registry entry the local stack's own services are configured from.
 *
 * A `VITE_*` entry is left out because its value is written to be shipped in a
 * public bundle: it identifies no part of the stack, and the generic literals
 * some of them carry would match text the compose file writes for its own
 * reasons.
 */
function stackConfiguredNames(): string[] {
  const modes = Object.values(Mode);
  return Object.entries(envConfig)
    .filter(([, config]) =>
      modes.some((mode) => {
        const destinations = getDestinations(config as VariableConfig, mode);
        return (
          destinations.includes(Destination.Backend) || destinations.includes(Destination.Scripts)
        );
      })
    )
    .map(([name]) => name);
}

/**
 * The entries whose value the backend schema draws from a closed set of words.
 *
 * Read off the schema rather than judged word by word, so an entry constrained
 * later is covered the moment it is.
 */
const CLOSED_SET_NAMES: ReadonlySet<string> = new Set(
  Object.entries(backendEnvSchema.shape)
    .filter(
      ([, field]) => (field instanceof z.ZodOptional ? field.unwrap() : field) instanceof z.ZodEnum
    )
    .map(([name]) => name)
);

/**
 * Every value the environment owns, against the variable that owns it.
 *
 * A number is dropped: it is not an identity, and the numbers the compose file
 * carries are protocol ports and server tuning. Which host port each service
 * publishes is `dev-ports.test.ts`'s question. A word drawn from a closed set
 * goes the same way and for the same reason — it names one of a fixed few
 * states rather than a thing, so an unrelated occurrence of it is not a second
 * spelling of anything.
 */
function ownedValues(env: NodeJS.ProcessEnv): Map<string, string> {
  const owned = new Map<string, string>();
  const record = (name: string, value: string | undefined): void => {
    if (value === undefined || value === '' || /^\d+$/u.test(value)) return;
    if (CLOSED_SET_NAMES.has(name)) return;
    if (!owned.has(value)) owned.set(value, name);
  };

  for (const [name, value] of Object.entries(composeEnvValues())) record(name, value);
  for (const name of stackConfiguredNames()) record(name, env[name]);
  return owned;
}

/** Every second spelling `source` carries, said as the reader has to fix it. */
function duplicatedValues(source: string, owned: ReadonlyMap<string, string>): string[] {
  const document: unknown = parseYaml(source);
  const findings = new Set<string>();

  for (const scalar of scalarsIn(document, [])) {
    const spellings = spellingsOf(scalar);
    for (const [value, name] of owned) {
      if (spellings.some((spelling) => includesAsToken(spelling, value, TOKEN_CHAR))) {
        findings.add(`${name} is spelled a second time in "${scalar.trim()}"`);
      }
    }
  }
  return [...findings];
}

/** A compose file of the same shape as the real one, for the cases below. */
function sampleCompose(lines: readonly string[]): string {
  return ['services:', '  postgres:', ...lines].join('\n');
}

describe('the values docker-compose.yml carries', () => {
  it('spells none the environment already owns', () => {
    expect(duplicatedValues(composeSource(), ownedValues(process.env))).toStrictEqual([]);
  });

  it('owns no value this file declares as a name', () => {
    const declared = declaredNames(parseYaml(composeSource()));

    const collisions = [...ownedValues(process.env)]
      .filter(([value]) => declared.has(value))
      .map(([value, name]) => `${name} carries ${value}, which this file declares as a name`);

    expect(collisions).toStrictEqual([]);
  });

  it('demands only variables the loaded environment carries', () => {
    const demanded = [...composeSource().matchAll(/\$\{(?<name>\w+)/gu)].map(
      (match) => match.groups?.['name'] ?? ''
    );

    expect(demanded.filter((name) => process.env[name] === undefined)).toStrictEqual([]);
  });

  it('reads back every variable the compose-facing derivation writes', () => {
    const source = composeSource();
    // A bucket is read back through the one list the object-store setup service
    // loops over, which the generator resolves from the same declaration the
    // readiness gate waits on — so it is read back only while the file asks for
    // that list.
    const readsTheBucketList = source.includes(`\${${STACK_BUCKET_LIST_VARIABLE}:?`);
    const unread = Object.values(COMPOSE_ENV_VARIABLES).filter(
      (name) =>
        !source.includes(`\${${name}:?`) &&
        !(readsTheBucketList && (STACK_BUCKET_VARIABLES as readonly string[]).includes(name))
    );

    expect(unread).toStrictEqual([]);
  });
});

describe('the reader behind it', () => {
  const owned = new Map([
    ['a-role', 'HB_SAMPLE_USER'],
    ['a-bucket', 'HB_SAMPLE_BUCKET'],
    ['a-database', 'HB_SAMPLE_DATABASE'],
    ['postgres', 'HB_SAMPLE_SERVICE_SHAPED'],
  ]);

  it('reports a value assigned to a container variable', () => {
    const findings = duplicatedValues(
      sampleCompose(['    environment:', '      POSTGRES_USER: a-role']),
      owned
    );

    expect(findings).toStrictEqual(['HB_SAMPLE_USER is spelled a second time in "a-role"']);
  });

  it('reports a value written into a command line', () => {
    const findings = duplicatedValues(
      sampleCompose(['    entrypoint: mc mb -p local/a-bucket']),
      owned
    );

    expect(findings).toStrictEqual([
      'HB_SAMPLE_BUCKET is spelled a second time in "mc mb -p local/a-bucket"',
    ]);
  });

  it('reads a substitution of the owning variable as no spelling at all', () => {
    const findings = duplicatedValues(
      sampleCompose([
        '    entrypoint: mc mb -p local/${HB_SAMPLE_BUCKET:?why}',
        '    environment:',
        '      POSTGRES_USER: ${HB_SAMPLE_USER:?why}',
      ]),
      owned
    );

    expect(findings).toStrictEqual([]);
  });

  it('reports a value an environment entry list assigns', () => {
    const findings = duplicatedValues(
      sampleCompose(['    environment:', '      - POSTGRES_USER=a-role']),
      owned
    );

    expect(findings).toStrictEqual([
      'HB_SAMPLE_USER is spelled a second time in "POSTGRES_USER=a-role"',
    ]);
  });

  it('reports the values a composite one spells', () => {
    const findings = duplicatedValues(
      sampleCompose([
        '    environment:',
        "      MAINTENANCE_URL: 'postgresql://a-role@postgres:5432/a-database'",
      ]),
      owned
    );

    expect(findings).toStrictEqual([
      'HB_SAMPLE_USER is spelled a second time in "postgresql://a-role@postgres:5432/a-database"',
      'HB_SAMPLE_DATABASE is spelled a second time in "postgresql://a-role@postgres:5432/a-database"',
      'HB_SAMPLE_SERVICE_SHAPED is spelled a second time in "postgresql://a-role@postgres:5432/a-database"',
    ]);
  });

  it('reports an owned value a longer name is built around', () => {
    const findings = duplicatedValues(
      sampleCompose(['    volumes:', '      - ./docker/a-bucket.json:/seed:ro']),
      owned
    );

    expect(findings).toStrictEqual([
      'HB_SAMPLE_BUCKET is spelled a second time in "./docker/a-bucket.json:/seed:ro"',
    ]);
  });

  it('reports an owned value standing as a path segment', () => {
    const findings = duplicatedValues(
      sampleCompose(['    volumes:', '      - ./docker/a-bucket/seed:/seed:ro']),
      owned
    );

    expect(findings).toStrictEqual([
      'HB_SAMPLE_BUCKET is spelled a second time in "./docker/a-bucket/seed:/seed:ro"',
    ]);
  });

  it('reports an owned value written where a service address goes', () => {
    const findings = duplicatedValues(
      sampleCompose(['    environment:', "      APPEND_PORT: 'postgres:5432'"]),
      owned
    );

    expect(findings).toStrictEqual([
      'HB_SAMPLE_SERVICE_SHAPED is spelled a second time in "postgres:5432"',
    ]);
  });

  it('reports an owned value a command line runs as its program', () => {
    const findings = duplicatedValues(sampleCompose(['    command: a-role -c fsync=off']), owned);

    expect(findings).toStrictEqual([
      'HB_SAMPLE_USER is spelled a second time in "a-role -c fsync=off"',
    ]);
  });

  it('reports an owned value a healthcheck probe names', () => {
    const findings = duplicatedValues(
      sampleCompose(['    healthcheck:', "      test: ['CMD-SHELL', 'pg_isready -U a-role']"]),
      owned
    );

    expect(findings).toStrictEqual([
      'HB_SAMPLE_USER is spelled a second time in "pg_isready -U a-role"',
    ]);
  });

  it('leaves the image a service names alone', () => {
    const findings = duplicatedValues(sampleCompose(['    image: postgres:18-alpine']), owned);

    expect(findings).toStrictEqual([]);
  });

  it('leaves a short-form dependency naming another service alone', () => {
    const findings = duplicatedValues(
      sampleCompose(['    depends_on:', '      - postgres']),
      owned
    );

    expect(findings).toStrictEqual([]);
  });

  it('reports an owned value written as a mapping key', () => {
    const findings = duplicatedValues(
      sampleCompose(['    labels:', "      a-database: 'seeded'"]),
      owned
    );

    expect(findings).toStrictEqual(['HB_SAMPLE_DATABASE is spelled a second time in "a-database"']);
  });
});

describe('the values it owns', () => {
  it('drops one the registry\u2019s schema draws from a closed set', () => {
    expect([...ownedValues(process.env).values()]).not.toContain('NODE_ENV');
  });

  it('keeps one no closed set constrains', () => {
    expect([...ownedValues(process.env).values()]).toContain('DATABASE_URL');
  });
});
