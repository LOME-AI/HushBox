/**
 * Whether the workspace resolves one `@types/node` across the vitest seam, or two.
 *
 * Two placements hide a second instance. A workspace project declaring no
 * `@types/node` of its own has one resolved for it while `auto-install-peers` is on,
 * taken fresh from the registry at whatever is newest and named only inside the
 * runner version that project resolves, where nothing weighs it against what the
 * rest of the workspace declares. Separately, the coverage and test-ui packages
 * declare no `@types/node` of their own and reach one through the `vitest` they
 * nest; their lockfile keys name the runner and stop there, so one instance is
 * chosen for every consumer of such a key, whichever resolver ran first fixes it,
 * and a later re-resolution preserves that choice rather than revisiting it.
 *
 * One repair covers both: declare `@types/node` in every workspace project, and
 * keep peer auto-install off so a project declaring nothing has nothing invented
 * for it.
 *
 * Nothing else in the repository sees the choice. Lint, the architecture rules,
 * every package suite and a frozen install pass in both directions; without this
 * the sole alarm is one package's typecheck, firing two layers from the cause.
 */
import { parse } from 'yaml';
import { z } from 'zod';

const DependencyBlock = z.record(z.string(), z.object({ version: z.string() }));

const LockfileShape = z.object({
  importers: z.record(
    z.string(),
    z.object({
      dependencies: DependencyBlock.optional(),
      devDependencies: DependencyBlock.optional(),
    })
  ),
  snapshots: z.record(
    z.string(),
    z.object({ dependencies: z.record(z.string(), z.string()).optional() })
  ),
});

type Lockfile = z.infer<typeof LockfileShape>;

const RUNNER = 'vitest';
const TYPES = '@types/node';

const TYPES_INSTANCE = /\(@types\/node@([^)]+)\)/gu;

/**
 * What a reader who has never met this failure needs, carried by the failure
 * itself: the alarm it replaces fires two layers from the cause.
 */
const CAUSE = [
  `A workspace project declaring no ${TYPES} has one resolved for it, and a snapshot key naming`,
  `${RUNNER} without naming ${TYPES} cannot tell two of them apart. Neither placement states which`,
  'instance is intended, so a resolver is free to settle a second one there and every later',
  'resolution preserves it. Code extending a runner class across that seam then types its base and',
  'its own imports from two different runner declaration files, which surfaces as TS2416',
  `and TS2345 citing a private field no source file wrote. Repair by declaring ${TYPES} in each`,
  'workspace project that omits it, at the version the rest of the workspace states, and by keeping',
  'peer auto-install off so nothing is invented for a project that declares nothing.',
].join(' ');

/**
 * A resolved `vitest` version names its runtime-types instance more than once —
 * as its own peer, and again inside the bundler suffix that is part of the
 * runner's identity — so the distinct instances are what a key stands for.
 */
function instancesIn(version: string): string[] {
  return [...new Set([...version.matchAll(TYPES_INSTANCE)].flatMap((match) => match.slice(1)))];
}

function hold(holders: Map<string, string[]>, instance: string, holder: string): void {
  const existing = holders.get(instance);

  if (existing === undefined) {
    holders.set(instance, [holder]);
    return;
  }

  existing.push(holder);
}

/**
 * Each snapshot naming the runner without naming a runtime-types instance,
 * paired with the runner version it nests.
 */
function undiscriminatedRunners(snapshots: Lockfile['snapshots']): [string, string][] {
  return Object.entries(snapshots).flatMap(([key, body]) => {
    const version = body.dependencies?.[RUNNER];

    return key.includes(`(${RUNNER}@`) && !key.includes(`${TYPES}@`) && version !== undefined
      ? [[key, version] satisfies [string, string]]
      : [];
  });
}

/** Each importer declaring one of `keys`, paired with the instance it states. */
function declaringImporters(
  importers: Lockfile['importers'],
  keys: ReadonlySet<string>
): [string, string][] {
  return Object.entries(importers).flatMap(([name, importer]) => {
    const declared = { ...importer.dependencies, ...importer.devDependencies };
    const declares = Object.entries(declared).some(([dependency, { version }]) =>
      keys.has(`${dependency}@${version}`)
    );
    const types = declared[TYPES]?.version;

    return declares && types !== undefined ? [[name, types] satisfies [string, string]] : [];
  });
}

/**
 * Each importer resolving the runner directly, paired with the instance that
 * resolution is built against — the placement a discriminated key records and no
 * snapshot scan reaches, because the importer names its own runner.
 */
function resolvedRunners(importers: Lockfile['importers']): [string, string][] {
  return Object.entries(importers).flatMap(([name, importer]) => {
    const version = { ...importer.dependencies, ...importer.devDependencies }[RUNNER]?.version;

    return version === undefined
      ? []
      : instancesIn(version).map((instance) => [name, instance] satisfies [string, string]);
  });
}

function split(holders: ReadonlyMap<string, readonly string[]>): string {
  return [
    `${TYPES} is split ${String(holders.size)} ways across the ${RUNNER} seam:`,
    ...[...holders.entries()]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([instance, named]) => `  ${TYPES}@${instance} — ${named.join(', ')}`),
    CAUSE,
  ].join('\n');
}

/**
 * Two failure shapes: a split names each instance with the holders on its side, what
 * the disagreement surfaces as and how to repair it; a hazard class that names an
 * instance no importer states at all names those keys instead, and says a split there
 * would go unseen. An importer stating one — by declaring the package, or by resolving
 * the runner itself — takes the shape out of the hazard branch, so a stated
 * disagreement is reported as the split it is. `undefined` for the two states that are
 * neither: one instance across every holder, and no holder at all.
 */
export function runnerTypesSplitFailure(lockfile: string): string | undefined {
  const { importers, snapshots } = LockfileShape.parse(parse(lockfile));
  const undiscriminated = undiscriminatedRunners(snapshots);
  const holders = new Map<string, string[]>();

  for (const [key, version] of undiscriminated) {
    for (const instance of instancesIn(version)) {
      hold(holders, instance, `snapshot ${key}`);
    }
  }

  const stated: [string, string][] = [
    ...declaringImporters(importers, new Set(undiscriminated.map(([key]) => key))).map(
      ([name, instance]) => [`importer ${name}`, instance] satisfies [string, string]
    ),
    ...resolvedRunners(importers).map(
      ([name, instance]) => [`${RUNNER} in importer ${name}`, instance] satisfies [string, string]
    ),
  ];

  for (const [holder, instance] of stated) {
    hold(holders, instance, holder);
  }

  if (holders.size > 0 && stated.length === 0) {
    return [
      `${undiscriminated.map(([key]) => key).join(', ')} nest a ${RUNNER} built against a ${TYPES}, but`,
      `no importer declaring one of those packages states a ${TYPES}, and none resolves the ${RUNNER}`,
      'itself, so nothing states which instance is intended and a split here would go unseen.',
    ].join(' ');
  }

  return holders.size <= 1 ? undefined : split(holders);
}
