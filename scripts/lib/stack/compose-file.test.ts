import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { CLONE_DIR_LABEL } from '../../docker-cleanup.js';
import { CLONE_DIR_VARIABLE } from '../../with-env.js';
import { STACK_MODES } from './port-plan.js';
import { STACK_BUCKET_LIST_VARIABLE, mediaBucketName } from './stack-bucket.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

const COMPOSE_FILE = 'docker-compose.yml';

/** One substitution compose performs while resolving the compose file. */
interface Substitution {
  /** Whether it is the braced form, the only one that can demand a value. */
  readonly braced: boolean;
  /** What sits between the braces, or the bare name that followed the `$`. */
  readonly body: string;
}

/**
 * Every substitution compose performs on the file, in file order.
 *
 * The set is read off the file rather than listed, so a mapping added to the
 * compose file is covered by the assertions below without anyone extending a
 * list. `$$` is compose's escape for a literal dollar, which the healthcheck's
 * container shell scripts are full of, and it is matched first so a doubled
 * dollar yields no substitution at all.
 */
function substitutionsIn(source: string): Substitution[] {
  return [...source.matchAll(/\$\$|\$\{(?<braced>[^}]*)\}|\$(?<bare>\w+)/g)].flatMap(
    (match): Substitution[] => {
      const { braced, bare } = match.groups ?? {};
      if (braced !== undefined) return [{ braced: true, body: braced }];
      if (bare !== undefined) return [{ braced: false, body: bare }];
      return [];
    }
  );
}

function composeSource(): string {
  return readFileSync(path.join(REPO_ROOT, COMPOSE_FILE), 'utf8');
}

/**
 * The message of the demand a substitution carries, or `null` when it carries none.
 *
 * A demand is the `:?` operator applied to the variable itself, so the operator is
 * read off the position that follows the name rather than found anywhere in the
 * body: `${NAME:-5432:?why}` defaults, it does not demand. A body holding a further
 * `${` is left unparsed and so carries no demand — the substitution pattern cuts at
 * the first `}`, which makes such a body a fragment of a nested construction rather
 * than one substitution's grammar, and compose resolves the nesting this file cannot.
 */
function demandMessage(entry: Substitution): string | null {
  if (!entry.braced || entry.body.includes('${')) return null;
  const { message } = /^\w+:\?(?<message>[\s\S]*)$/.exec(entry.body)?.groups ?? {};
  return message ?? null;
}

/** The bodies of the substitutions in `source` that do not demand a value. */
function substitutionsWithoutDemand(source: string): string[] {
  return substitutionsIn(source)
    .filter((entry) => demandMessage(entry) === null)
    .map((entry) => entry.body);
}

describe('compose file substitutions', () => {
  it('demands a value for every substitution it performs', () => {
    expect(substitutionsWithoutDemand(composeSource())).toStrictEqual([]);
  });

  it('gives every demand a non-empty message', () => {
    const silent = substitutionsIn(composeSource())
      .filter((entry) => demandMessage(entry) === '')
      .map((entry) => entry.body);

    expect(silent).toStrictEqual([]);
  });

  it('reads a demand nested inside a fallback as no demand of the outer substitution', () => {
    expect(substitutionsWithoutDemand('published: ${HB_A_PORT:-${HB_B_PORT:?why}}')).toStrictEqual([
      'HB_A_PORT:-${HB_B_PORT:?why',
    ]);
  });

  it('reads a fallback value spelling the demand operator as no demand', () => {
    expect(substitutionsWithoutDemand('published: ${HB_A_PORT:-5432:?why}')).toStrictEqual([
      'HB_A_PORT:-5432:?why',
    ]);
  });

  it('reads a doubled dollar as a literal rather than a substitution', () => {
    expect(substitutionsIn('echo $$HOME and ${WANTED:?why}')).toStrictEqual([
      { braced: true, body: 'WANTED:?why' },
    ]);
  });

  it('reports the unbraced form, which cannot carry a demand', () => {
    expect(substitutionsIn('published: $LOOSE')).toStrictEqual([{ braced: false, body: 'LOOSE' }]);
  });
});

describe('the buckets the compose file creates', () => {
  it('asks the environment for the whole list of them', () => {
    const named = substitutionsIn(composeSource()).map((entry) => entry.body.split(':')[0]);

    expect(named).toContain(STACK_BUCKET_LIST_VARIABLE);
  });

  // A bucket name written here would be the second spelling of a stack's
  // identity, and the one that decides which objects a bring-up creates: the
  // stack whose files are loaded is the stack whose bucket must appear.
  it.each([...STACK_MODES])('spells the %s stack own bucket nowhere', (stackMode) => {
    expect(composeSource()).not.toContain(mediaBucketName(stackMode));
  });
});

describe('the clone the compose file stamps on every container it starts', () => {
  /** The services the file declares, with whatever labels each carries. */
  function servicesIn(source: string): [string, { labels?: Record<string, string> }][] {
    const document = parseYaml(source) as {
      services?: Record<string, { labels?: Record<string, string> }>;
    };
    return Object.entries(document.services ?? {});
  }

  it('stamps the label the teardown reads on every service', () => {
    const unstamped = servicesIn(composeSource())
      .filter(([, service]) => service.labels?.[CLONE_DIR_LABEL] === undefined)
      .map(([name]) => name);

    expect(unstamped).toStrictEqual([]);
  });

  it('takes the value from the variable a run publishes its checkout in', () => {
    expect(composeSource()).toContain(`${CLONE_DIR_LABEL}: \${${CLONE_DIR_VARIABLE}:?`);
  });
});
