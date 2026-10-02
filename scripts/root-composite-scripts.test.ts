import { describe, it, expect } from 'vitest';
import { reachesThroughReferences, rootScripts, tokensOf } from './lib/root-manifest.js';
import { parseEnvModeSelection } from './with-env.js';
import { STAGE_SEPARATOR, parseStages } from './with-run-claim.js';

const WRAPPER = 'with-run-claim.ts';

/**
 * The words a compose command line opens with: the client, hyphenated or not,
 * and the entry point this repository reaches compose through — which names the
 * project directory the client would otherwise take from the spelling the
 * checkout was reached by.
 */
const COMPOSE_CLIENTS = ['docker', 'docker-compose', 'scripts/compose.ts'];

/** The compose verbs that leave containers running: `up` creates them, `start` resumes them. */
const BRING_UP_VERBS = ['up', 'start'];

/** How {@link startsContainers} reads, for the failure messages that explain it. */
const BRING_UP_READS = `a ${COMPOSE_CLIENTS.join(' or ')} word with a later ${BRING_UP_VERBS.join(' or ')} word`;

/**
 * The hand-rolled container bring-up that predates the stack CLI, read as two
 * words rather than as a phrase: a client word, and any {@link BRING_UP_VERBS}
 * word after it. Everything between them is therefore free — a project flag, an
 * environment file, repeated spacing — and the hyphenated client reads the same
 * as the subcommand. The verb is the whole of what identifies a bring-up: a
 * service name is neither necessary (`up` with no list starts them all) nor
 * sufficient (`exec <service>` only reaches one already running).
 *
 * The cost of reading the verb anywhere after the client is that a body running
 * a docker command and, later in the same fragment, an unrelated word `up` or
 * `start` reads as a bring-up. That direction only over-reports, and both gates
 * below are hazard gates where over-reporting is the safe error.
 */
function startsContainers(fragment: string): boolean {
  const words = tokensOf(fragment);
  const client = words.findIndex((word) => COMPOSE_CLIENTS.includes(word));
  return client !== -1 && words.slice(client + 1).some((word) => BRING_UP_VERBS.includes(word));
}

/**
 * The other spelling of "make the local stack ready" a root script can reach.
 * A script naming it, or running a bring-up, has prepared something a later
 * command can destroy — which is what makes the conjunction after it a hazard
 * rather than an ordering.
 */
const STACK_CLI = 'ensure-stack-cli.ts';

/** What a shell runs as a separate process once the one before it succeeded. */
const CONJUNCTION = '&&';

/**
 * Root scripts known to reach stack preparation. The derivation finds them on
 * its own; this list is the non-vacuity floor. Without it a discovery bug — a
 * renamed entry point, a reworded invocation — narrows the derived set to
 * nothing and every case below passes over an empty list.
 */
const KNOWN_PREPARING: readonly string[] = [
  'dev',
  'test',
  'test:pkg',
  'preview',
  'e2e',
  'e2e:prepare',
  'e2e:fast',
  'mobile:test',
  'db:up',
  'db:reset',
];

/** Whether running this fragment makes the stack ready, however indirectly. */
function preparesStack(body: string, scripts: Record<string, string>): boolean {
  return reachesThroughReferences(
    body,
    scripts,
    (fragment) => fragment.includes(STACK_CLI) || startsContainers(fragment)
  );
}

/** The separate processes a body runs, in order. */
function segments(body: string): string[] {
  return body.split(CONJUNCTION).map((segment) => segment.trim());
}

/**
 * What a script leaves running unclaimed: preparation in one process, and
 * anything at all in a process after it. Between the two the slot carries no
 * live claim, so a wipe taking the section there destroys what the first
 * process just built.
 */
function continuesPastPreparation(body: string, scripts: Record<string, string>): boolean {
  const parts = segments(body);
  return parts.some(
    (segment, index) => index < parts.length - 1 && preparesStack(segment, scripts)
  );
}

/**
 * Compose command lines that start the cluster's containers, spelled the ways a
 * root script could legitimately be written — a flag between the client and the
 * verb, the hyphenated client, repeated spacing, the verb that resumes a
 * container left stopped. Both gates below read this one list, because both
 * take their marker from the same words.
 */
const STARTS_CONTAINERS: readonly string[] = [
  'docker compose up -d --wait',
  'docker compose -p hushbox up -d',
  'docker-compose up -d',
  'docker compose  up -d',
  'docker compose start postgres',
  'tsx scripts/compose.ts up -d --wait',
];

/** A compose command line that only addresses a container already running. */
const LEAVES_CONTAINERS_ALONE = 'docker compose exec postgres psql hushbox';

describe('root scripts that make the stack ready', () => {
  it('still derives every root script known to reach stack preparation', () => {
    const scripts = rootScripts();
    const missing = KNOWN_PREPARING.filter((name) => {
      const body = scripts[name];
      return body === undefined || !preparesStack(body, scripts);
    });

    expect(
      missing,
      `the derivation (a root script naming ${STACK_CLI}, or running ${BRING_UP_READS}, directly or through another root script it runs) no longer reaches ${JSON.stringify(missing)}, so the cases below assert over less than they claim`
    ).toEqual([]);
  });

  // What the case "never hands the stack it prepared to a second process that
  // claims separately" asserts is an empty list, which an over-narrow derivation
  // also produces. This case is the other half of that non-vacuity floor: a
  // script written the way every one of these was written before the wrapper is
  // still recognised as broken.
  it('still recognises a script that prepares in one process and continues in another', () => {
    const scripts = {
      'a-composite': 'pnpm ensure-stack && tsx scripts/with-env.ts tsx scripts/some-work.ts',
      'ensure-stack': 'tsx scripts/ensure-stack-cli.ts',
    };

    expect(continuesPastPreparation(scripts['a-composite'], scripts)).toBe(true);
  });

  // The marker both gates read is one derivation, so what the auth gate reaches
  // is what this gate counts as preparation. Pinned here rather than reasoned
  // about, because widening the marker changes which scripts this gate judges.
  it.each(STARTS_CONTAINERS)('counts `%s` as stack preparation', (body) => {
    expect(preparesStack(body, {})).toBe(true);
  });

  it('never counts a body that only reaches into a running container as preparation', () => {
    expect(preparesStack(LEAVES_CONTAINERS_ALONE, {})).toBe(false);
  });

  it('never hands the stack it prepared to a second process that claims separately', () => {
    const scripts = rootScripts();
    const broken = Object.entries(scripts)
      .filter(([, body]) => continuesPastPreparation(body, scripts))
      .map(([name]) => name);

    expect(
      broken,
      `these root scripts prepare the stack in one process and then run more work in another: ${JSON.stringify(broken)}. Each process registers its own run claim and releases it on exit, so between them the slot carries no live claim and a wipe taking the section there destroys the volumes the first half just prepared. Run the stages under one claim instead: \`tsx scripts/${WRAPPER} <command> ${STAGE_SEPARATOR} <command>\``
    ).toEqual([]);
  });
});

/**
 * The two spellings of "the cluster now asks for the authentication method the
 * driver sends": the stack CLI runs the repair as one of its steps, and the
 * standalone gate runs the same repair by itself. A bring-up reaching neither
 * leaves a volume older than the compose setting refusing every database call
 * (`scripts/lib/stack/postgres-auth-method.ts`).
 */
const AUTH_REPAIR = ['ensure-stack-cli.ts', 'db-auth-ready.ts'];

/** Whether running this body starts the cluster's containers by hand. */
function startsTheCluster(body: string, scripts: Record<string, string>): boolean {
  return reachesThroughReferences(body, scripts, startsContainers);
}

/** Whether running this body leaves the cluster asking for that method. */
function repairsAuthMethod(body: string, scripts: Record<string, string>): boolean {
  return reachesThroughReferences(body, scripts, (fragment) =>
    AUTH_REPAIR.some((marker) => fragment.includes(marker))
  );
}

/** The scripts of a manifest that start the cluster and reach no repair. */
function unrepairedStarts(scripts: Record<string, string>): string[] {
  return Object.entries(scripts)
    .filter(([, body]) => startsTheCluster(body, scripts) && !repairsAuthMethod(body, scripts))
    .map(([name]) => name);
}

describe('root scripts that start the cluster themselves', () => {
  it('still derives the bring-up the repository declares', () => {
    const scripts = rootScripts();
    const starting = Object.entries(scripts)
      .filter(([, body]) => startsTheCluster(body, scripts))
      .map(([name]) => name);

    expect(
      starting,
      `no root script spells ${BRING_UP_READS} any more, so the case below asserts over nothing`
    ).toContain('db:up');
  });

  // The derivation's reach is the whole of what this gate is worth, so both
  // edges of it are pinned against manifests written here rather than against
  // the repository's, which exercises only the shape that exists today.
  it.each(STARTS_CONTAINERS)('names `%s` as a bring-up that reaches no repair', (body) => {
    expect(unrepairedStarts({ 'stack:up': body })).toEqual(['stack:up']);
  });

  it('never flags a body that only reaches into a container already running', () => {
    expect(unrepairedStarts({ 'db:psql': LEAVES_CONTAINERS_ALONE })).toEqual([]);
  });

  it('repairs the authentication method the cluster asks for', () => {
    const unrepaired = unrepairedStarts(rootScripts());

    expect(
      unrepaired,
      `these root scripts start the cluster without reaching ${AUTH_REPAIR.join(' or ')}: ${JSON.stringify(unrepaired)}. A volume initialised before the compose file selected the method keeps the one it was born with, and the driver's pipelined connect cannot answer it, so every database call against a cluster reached only this way fails`
    ).toEqual([]);
  });
});

describe('the chains that run under one run claim', () => {
  it('sequences stages only through the wrapper that holds the claim', () => {
    const stray = Object.entries(rootScripts())
      .filter(([, body]) => body.includes(STAGE_SEPARATOR) && !body.includes(WRAPPER))
      .map(([name]) => name);

    expect(
      stray,
      `these root scripts sequence stages with \`${STAGE_SEPARATOR}\` but do not run through scripts/${WRAPPER}, which is what holds one claim over them: ${JSON.stringify(stray)}`
    ).toEqual([]);
  });

  it('gives the wrapper stages it can run', () => {
    for (const [name, body] of Object.entries(rootScripts())) {
      if (!body.includes(WRAPPER)) continue;
      const argv = body
        .slice(body.indexOf(WRAPPER) + WRAPPER.length)
        .trim()
        .split(/\s+/);
      // Read the way the entry point reads it, so a stack selection meant for
      // the wrapper is not mistaken here for a stage's command.
      const { rest } = parseEnvModeSelection(argv);
      // Every stage naming a command it can run is the whole of what the parser
      // admits, the separator taken for an argument included.
      expect(() => parseStages(rest), `root script "${name}"`).not.toThrow();
    }
  });
});
