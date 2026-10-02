/**
 * No image the local stack runs floats to `latest`, the images that carry a
 * digest name one fixed build, and CI caches the ones a cached tar can stand in
 * for by asking the compose file for them rather than by keeping a copy.
 *
 * PINS. A reference that floats — the `latest` tag, or neither a tag nor a
 * digest, which a pull reads as `latest` — resolves to whatever the registry
 * serves on the day of the pull, so two machines on one commit can run
 * different builds. The services {@link TAG_AND_DIGEST_SERVICES} names are
 * pinned by tag and digest together: Dependabot's compose updater advances the
 * two as a pair, and the digest is what a pull verifies. An image whose upstream
 * publishes no tag but `latest` is pinned by digest alone. Any other image names
 * a tag alone, which its registry may move to a newer build.
 *
 * THE CACHE LIST IS DERIVED. A workflow step that runs `docker save` takes its
 * images from the compose file's `config --images` output, run under the stack
 * mode its job declares, and hands each to `docker save` through a shell
 * expansion. A list written into a workflow would be a copy of the compose file
 * that drifts silently: a stale digest reads exactly like a fresh one and shows
 * only as a red job. The steps are found by walking each workflow document's
 * jobs and steps, not by naming files or steps here.
 *
 * DIGEST REFERENCES ARE NOT SAVED. A `docker save` and `docker load` round trip
 * restores no digest reference on Docker's classic image store, so compose
 * pulls a digest-pinned image whatever the cache holds. Each saving loop skips
 * a reference containing `@` with a guard on the variable it saves, ahead of
 * the save, and skips nothing else.
 *
 * WHAT IT CANNOT SEE. A `docker save` whose first argument is neither an
 * expansion nor an image is reported as a form this reading takes no image
 * from, so a rewritten step fails loudly rather than emptily. Beyond that:
 * anything outside the workflow directory and the compose file, so an image a
 * composite action or an ops script saves is not read; and whether the
 * expansion a save names carries the listed images, since the reading sees that
 * the step runs the list command, not where its output flows; and a filter that
 * is not a `continue`, such as a `grep` over the list, since the reading counts
 * the loop's skips rather than following the list through the shell.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { ENV_MODE_VARIABLE } from './stack-mode.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

const COMPOSE_FILE = 'docker-compose.yml';

const WORKFLOW_DIR = path.join('.github', 'workflows');

/** The command that prints the compose file's images, under the stack env it needs to resolve. */
const IMAGE_LIST_COMMAND =
  'pnpm exec tsx scripts/with-env.ts tsx scripts/compose.ts config --images';

/**
 * The services whose image the compose file pins to one release tag plus that
 * tag's digest: the digest fixes the build a pull verifies, and the tag is what
 * Dependabot's compose updater reads to advance the digest with it.
 */
const TAG_AND_DIGEST_SERVICES = ['serverless-redis-http', 'minio', 'minio-setup'] as const;

const TAG_AND_DIGEST = /^[^@]+:[^:/@]+@sha256:[0-9a-f]{64}$/u;

/** The registry hosts whose `minio/` namespace has stopped serving the MinIO images. */
const RETIRED_MINIO_HOSTS = new Set([undefined, 'docker.io', 'index.docker.io', 'quay.io']);

const DOCKER_SAVE = /(?:^|[\s;&|(])docker\s+save\b(?<args>[^\n]*)/gu;

const SAVE_COMMAND = /(?:^|[\s;&|(])docker\s+save\b/u;

interface ImageReference {
  /** The registry host, or undefined for Docker Hub's implicit default. */
  readonly registry: string | undefined;
  readonly repository: string;
  readonly tag: string | undefined;
  readonly digest: string | undefined;
}

/** One workflow step that runs `docker save`. */
interface SaveStep {
  /** The workflow, job and step, which is what tells two same-named steps apart. */
  readonly where: string;
  /** The text the shell runs, with what a `#` comment swallows taken out. */
  readonly script: string;
  /** The arguments ahead of the first option, one list per `docker save`. */
  readonly saves: readonly (readonly string[])[];
  /** The stack mode the step's job declares. */
  readonly jobMode: unknown;
  /** The stack mode the step sets for itself, overriding its job's. */
  readonly stepMode: unknown;
}

/**
 * Splits a reference the way a pull reads it: a first path component holding a
 * dot or a colon, or naming `localhost`, is a registry host; anything else
 * lives on Docker Hub.
 */
function parseReference(reference: string): ImageReference {
  const [named = '', digest] = reference.split('@');
  const lastSlash = named.lastIndexOf('/');
  const tagColon = named.indexOf(':', lastSlash + 1);
  const name = tagColon === -1 ? named : named.slice(0, tagColon);
  const tag = tagColon === -1 ? undefined : named.slice(tagColon + 1);
  const [first = '', ...rest] = name.split('/');
  const isHost = rest.length > 0 && (/[.:]/u.test(first) || first === 'localhost');
  return {
    registry: isHost ? first : undefined,
    repository: isHost ? rest.join('/') : name,
    tag,
    digest,
  };
}

function usesLatest(reference: string): boolean {
  return parseReference(reference).tag === 'latest';
}

/** A reference with no tag that no digest pins either, which a pull reads as `latest`. */
function omitsTagUnpinned(reference: string): boolean {
  const { tag, digest } = parseReference(reference);
  return tag === undefined && digest === undefined;
}

/** A `minio/` namespace that no longer serves the MinIO images: Docker Hub's or Quay's. */
function namesRetiredMinioNamespace(reference: string): boolean {
  const { registry, repository } = parseReference(reference);
  return RETIRED_MINIO_HOSTS.has(registry) && repository.startsWith('minio/');
}

/** The entries of a mapping node, and nothing for a node that is not one. */
function entriesOf(node: unknown): [string, unknown][] {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return [];
  return Object.entries(node);
}

function valueAt(node: unknown, key: string): unknown {
  return entriesOf(node).find(([name]) => name === key)?.[1];
}

/** Every service of a compose document that runs a pulled image, with that image. */
function composeServiceImages(source: string): [string, string][] {
  return entriesOf(valueAt(parseYaml(source), 'services')).flatMap(
    ([service, definition]): [string, string][] => {
      const image = valueAt(definition, 'image');
      return typeof image === 'string' ? [[service, image]] : [];
    }
  );
}

function composeImages(source: string): string[] {
  return [...new Set(composeServiceImages(source).map(([, image]) => image))];
}

/** The text a shell reads, with what a `#` comment swallows taken out. */
function withoutComments(script: string): string {
  return script.replaceAll(/(?:^|\s)#[^\n]*/gu, '');
}

/** The arguments each `docker save` in `script` names ahead of its first option. */
function saveArguments(script: string): string[][] {
  return [...script.matchAll(DOCKER_SAVE)].map((match) => {
    const named: string[] = [];
    for (const argument of (match.groups?.['args'] ?? '').trim().split(/\s+/u)) {
      if (argument === '' || argument.startsWith('-')) break;
      named.push(argument);
    }
    return named;
  });
}

/**
 * Every step of `source` that runs `docker save`, in job and step order.
 *
 * A step is one because its script spells `docker save` anywhere, comments
 * included, while what it saves is read from what the shell would actually
 * run. Reading both from the stripped text would make a step whose every save
 * is commented out no step at all, and it would drop out of every check here.
 */
function saveStepsIn(workflow: string, source: string): SaveStep[] {
  return entriesOf(valueAt(parseYaml(source), 'jobs')).flatMap(([job, definition]) => {
    const steps: unknown = valueAt(definition, 'steps');
    if (!Array.isArray(steps)) return [];
    return steps.flatMap((step: unknown, index: number): SaveStep[] => {
      const run = valueAt(step, 'run');
      if (typeof run !== 'string' || !SAVE_COMMAND.test(run)) return [];
      const name = valueAt(step, 'name');
      const label = typeof name === 'string' ? name : `step ${String(index)}`;
      const script = withoutComments(run);
      return [
        {
          where: `${workflow} job "${job}" step "${label}"`,
          script,
          saves: saveArguments(script),
          jobMode: valueAt(valueAt(definition, 'env'), ENV_MODE_VARIABLE),
          stepMode: valueAt(valueAt(step, 'env'), ENV_MODE_VARIABLE),
        },
      ];
    });
  });
}

/** An argument the shell expands, rather than one that names its image in the text. */
function isExpansion(argument: string): boolean {
  return argument.startsWith('$') || argument.startsWith('"$');
}

/** Every `docker save` of `step` that names an image in the workflow text, or no image at all. */
function saveFindings(step: SaveStep): string[] {
  return step.saves.flatMap((named) =>
    named.length === 0
      ? [`${step.where} runs a docker save this reading takes no image from`]
      : named
          .filter((argument) => !isExpansion(argument))
          .map((argument) => `${step.where} saves ${argument}, an image written into the workflow`)
  );
}

/** Where `step` falls short of listing its images from the compose file under its job's mode. */
function listingFindings(step: SaveStep): string[] {
  return [
    ...(step.script.includes(IMAGE_LIST_COMMAND)
      ? []
      : [`${step.where} does not take its images from ${IMAGE_LIST_COMMAND}`]),
    ...(typeof step.jobMode === 'string'
      ? []
      : [`${step.where} runs in a job that declares no ${ENV_MODE_VARIABLE}`]),
    ...(step.stepMode === undefined && !step.script.includes('--env-mode')
      ? []
      : [`${step.where} lists its images under a mode other than its job's`]),
  ];
}

/**
 * The guard that skips a digest reference, on the loop variable `name`: a
 * test of the whole reference against `*@*` whose branch is `continue`.
 */
function digestSkipGuard(name: string): RegExp {
  return new RegExp(
    String.raw`if\s+\[\[\s+"\$\{?` +
      name +
      String.raw`\}?"\s+==\s+\*@\*\s+\]\];?\s*then\s+continue;?\s*fi`,
    'u'
  );
}

/** The variable an expansion argument names, such as `image` in `"$image"` or `${image}`. */
function expandedName(argument: string): string | undefined {
  return /^"?\$\{?(?<name>\w+)\}?"?$/u.exec(argument)?.groups?.['name'];
}

/**
 * Where `step` falls short of skipping every digest reference and saving
 * every other listed image: each expansion it saves needs the skip guard on its
 * own variable ahead of the first save, and no other `continue` may drop an image.
 */
function skipFindings(step: SaveStep): string[] {
  const firstSave = step.script.search(SAVE_COMMAND);
  const expansions = [...new Set(step.saves.flat().filter((argument) => isExpansion(argument)))];
  const guarded = expansions.filter((argument) => {
    const name = expandedName(argument);
    const guard = name === undefined ? null : digestSkipGuard(name).exec(step.script);
    return guard !== null && guard.index < firstSave;
  });
  const continues = [...step.script.matchAll(/\bcontinue\b/gu)].length;
  return [
    ...expansions
      .filter((argument) => !guarded.includes(argument))
      .map(
        (argument) => `${step.where} saves ${argument} without first skipping a digest reference`
      ),
    ...(continues > guarded.length
      ? [`${step.where} skips an image other than a digest reference`]
      : []),
  ];
}

function composeSource(): string {
  return readFileSync(path.join(REPO_ROOT, COMPOSE_FILE), 'utf8');
}

/** Every workflow document in the repository, as its file name and its text. */
function workflowSources(): [string, string][] {
  const directory = path.join(REPO_ROOT, WORKFLOW_DIR);
  return readdirSync(directory)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map((name) => [name, readFileSync(path.join(directory, name), 'utf8')]);
}

function saveSteps(): SaveStep[] {
  return workflowSources().flatMap(([name, source]) => saveStepsIn(name, source));
}

/** A compose document of the same shape as the real one, for the cases below. */
function sampleCompose(services: Record<string, string | null>): string {
  return [
    'services:',
    ...Object.entries(services).flatMap(([name, image]) => [
      `  ${name}:`,
      ...(image === null ? ['    build: .'] : [`    image: ${image}`]),
    ]),
  ].join('\n');
}

/** How a sample workflow departs from a named step in a job declaring the test mode. */
interface SampleShape {
  /** The step's name, or null for a step that carries none. */
  readonly stepName?: string | null;
  /** The job's stack mode, or null for a job that declares none. */
  readonly jobMode?: string | null;
}

/** A workflow document holding one job whose one step runs `script`. */
function sampleWorkflow(
  script: string,
  { stepName = 'Save Docker images', jobMode = 'test' }: SampleShape = {}
): string {
  return [
    'jobs:',
    '  checks:',
    ...(jobMode === null ? [] : ['    env:', `      ${ENV_MODE_VARIABLE}: ${jobMode}`]),
    '    steps:',
    ...(stepName === null ? ['      - run: |'] : [`      - name: ${stepName}`, '        run: |']),
    ...script.split('\n').map((line) => `          ${line}`),
  ].join('\n');
}

const DIGEST_SKIP = 'if [[ "$image" == *@* ]]; then continue; fi';

const DERIVED_SAVE = [
  `listed=$(${IMAGE_LIST_COMMAND})`,
  'mapfile -t images <<< "$listed"',
  'for image in "${images[@]}"; do',
  `  ${DIGEST_SKIP}`,
  '  docker save "$image" -o "/tmp/cache/$image.tar" &',
  'done',
].join('\n');

describe('the images the local stack runs', () => {
  const images = composeServiceImages(composeSource());
  const references = images.map(([, image]) => image);

  it('are read from the compose file, so the checks are over something', () => {
    expect(references.length).toBeGreaterThan(0);
  });

  it('declare an image on every service pinned by tag and digest', () => {
    expect(images.map(([service]) => service)).toEqual(
      expect.arrayContaining([...TAG_AND_DIGEST_SERVICES])
    );
  });

  it('use the latest tag nowhere', () => {
    expect(references.filter((image) => usesLatest(image))).toStrictEqual([]);
  });

  it('omit a tag only where a digest pins the image', () => {
    expect(references.filter((image) => omitsTagUnpinned(image))).toStrictEqual([]);
  });

  it('carry tag and digest on each image that publishes release tags', () => {
    const byService = new Map(images);
    const unpinned = TAG_AND_DIGEST_SERVICES.filter(
      (service) => !TAG_AND_DIGEST.test(byService.get(service) ?? '')
    );

    expect(unpinned).toStrictEqual([]);
  });

  it('come from no registry namespace that has stopped serving MinIO images', () => {
    expect(references.filter((image) => namesRetiredMinioNamespace(image))).toStrictEqual([]);
  });
});

describe('the images CI caches', () => {
  it('are saved by no docker save that names an image in the workflow', () => {
    expect(saveSteps().flatMap((step) => saveFindings(step))).toStrictEqual([]);
  });

  it('are spelled nowhere in a workflow', () => {
    const images = composeImages(composeSource());
    const spelled = workflowSources().flatMap(([name, source]) =>
      images.filter((image) => source.includes(image)).map((image) => `${name}: ${image}`)
    );

    expect(spelled).toStrictEqual([]);
  });

  it('are listed from the compose file under the stack mode each saving job declares', () => {
    expect(saveSteps().flatMap((step) => listingFindings(step))).toStrictEqual([]);
  });

  it('leave out every digest reference and save every other listed image', () => {
    expect(saveSteps().flatMap((step) => skipFindings(step))).toStrictEqual([]);
  });

  it('are checked against at least one saving step, so an empty reading cannot pass', () => {
    expect(saveSteps().length).toBeGreaterThan(0);
  });

  // The structural walk and this textual one have to find the same workflows: a
  // step nested somewhere the walk does not reach would otherwise drop out of
  // the check without anything saying so.
  it('are checked in every workflow whose text saves an image', () => {
    const unreached = workflowSources()
      .filter(([, source]) => source.includes('docker save'))
      .filter(([name, source]) => saveStepsIn(name, source).length === 0)
      .map(([name]) => name);

    expect(unreached).toStrictEqual([]);
  });
});

describe('the reference reading', () => {
  it('reads the latest tag as latest', () => {
    expect(usesLatest('minio/minio:latest')).toBe(true);
  });

  it('reads a version tag as not latest', () => {
    expect(usesLatest('redis:7-alpine')).toBe(false);
  });

  it('reads a reference with neither tag nor digest as unpinned', () => {
    expect(omitsTagUnpinned('redis')).toBe(true);
  });

  it('reads a digest with no tag as pinned', () => {
    expect(omitsTagUnpinned(`ghcr.io/neondatabase/wsproxy@sha256:${'a'.repeat(64)}`)).toBe(false);
  });

  it('reads a registry port as part of the host rather than as a tag', () => {
    expect(parseReference('localhost:5000/minio/minio')).toStrictEqual({
      registry: 'localhost:5000',
      repository: 'minio/minio',
      tag: undefined,
      digest: undefined,
    });
  });

  it('reads an unqualified minio repository as a retired MinIO namespace', () => {
    expect(namesRetiredMinioNamespace('minio/mc:latest')).toBe(true);
  });

  it('reads an explicit docker.io minio repository as a retired MinIO namespace', () => {
    expect(namesRetiredMinioNamespace('docker.io/minio/minio:latest')).toBe(true);
  });

  it('reads the quay.io minio server repository as a retired MinIO namespace', () => {
    expect(namesRetiredMinioNamespace('quay.io/minio/minio:latest')).toBe(true);
  });

  it('reads the quay.io minio client repository as a retired MinIO namespace', () => {
    expect(namesRetiredMinioNamespace('quay.io/minio/mc:latest')).toBe(true);
  });

  it('reads an unqualified repository outside the minio namespace as serving', () => {
    expect(namesRetiredMinioNamespace('pgsty/silo:latest')).toBe(false);
  });

  it('reads an explicit docker.io repository outside the minio namespace as serving', () => {
    expect(namesRetiredMinioNamespace('docker.io/pgsty/silo:latest')).toBe(false);
  });

  it('passes over a service built rather than pulled, which has no image to cache', () => {
    expect(composeImages(sampleCompose({ db: 'example/db:1', app: null }))).toStrictEqual([
      'example/db:1',
    ]);
  });
});

describe('the save reading', () => {
  const stepsOf = (yaml: string): SaveStep[] => saveStepsIn('sample.yml', yaml);
  const findingsOf = (yaml: string): string[] =>
    stepsOf(yaml).flatMap((step) => [
      ...saveFindings(step),
      ...listingFindings(step),
      ...skipFindings(step),
    ]);

  it('finds nothing in a step that saves the listed images through an expansion', () => {
    expect(findingsOf(sampleWorkflow(DERIVED_SAVE))).toStrictEqual([]);
  });

  it('reports a save that names its image in the workflow', () => {
    expect(
      findingsOf(sampleWorkflow(`${DERIVED_SAVE}\ndocker save example/db:1 -o /tmp/db.tar`))
    ).toStrictEqual([
      'sample.yml job "checks" step "Save Docker images" saves example/db:1, an image written into the workflow',
    ]);
  });

  it('reads a digest reference whole, rather than cutting it at its separators', () => {
    const digest = 'example/proxy@sha256:0123456789abcdef';

    expect(
      findingsOf(sampleWorkflow(`${DERIVED_SAVE}\ndocker save ${digest} -o /tmp/proxy.tar`))
    ).toStrictEqual([
      `sample.yml job "checks" step "Save Docker images" saves ${digest}, an image written into the workflow`,
    ]);
  });

  it('reports each named image of a save that names more than one', () => {
    expect(
      findingsOf(sampleWorkflow(`${DERIVED_SAVE}\ndocker save "$image" example/db:1 -o /tmp/x.tar`))
    ).toStrictEqual([
      'sample.yml job "checks" step "Save Docker images" saves example/db:1, an image written into the workflow',
    ]);
  });

  it('reports a save whose form puts no image where this reading looks', () => {
    expect(
      findingsOf(sampleWorkflow(`${DERIVED_SAVE}\ndocker save -o /tmp/db.tar example/db:1`))
    ).toStrictEqual([
      'sample.yml job "checks" step "Save Docker images" runs a docker save this reading takes no image from',
    ]);
  });

  it('reads a single-quoted dollar as a literal, since the shell does not expand it', () => {
    expect(
      findingsOf(sampleWorkflow(`${DERIVED_SAVE}\ndocker save '$image' -o /tmp/x.tar`))
    ).toStrictEqual([
      `sample.yml job "checks" step "Save Docker images" saves '$image', an image written into the workflow`,
    ]);
  });

  it('takes no image from a save a comment has swallowed', () => {
    expect(
      findingsOf(sampleWorkflow(`${DERIVED_SAVE}\n# docker save example/db:1 -o /tmp/db.tar`))
    ).toStrictEqual([]);
  });

  it('still reads a step whose every save a comment has swallowed', () => {
    expect(findingsOf(sampleWorkflow('# docker save example/db:1 -o /tmp/db.tar'))).toStrictEqual([
      `sample.yml job "checks" step "Save Docker images" does not take its images from ${IMAGE_LIST_COMMAND}`,
    ]);
  });

  it('reports a step that saves without running the list command', () => {
    expect(
      findingsOf(
        sampleWorkflow(
          `for image in $IMAGES; do ${DIGEST_SKIP}; docker save "$image" -o "/tmp/$image.tar"; done`
        )
      )
    ).toStrictEqual([
      `sample.yml job "checks" step "Save Docker images" does not take its images from ${IMAGE_LIST_COMMAND}`,
    ]);
  });

  it('does not count a list command a comment has swallowed', () => {
    expect(
      findingsOf(
        sampleWorkflow(
          `# ${IMAGE_LIST_COMMAND}\nfor image in $IMAGES; do ${DIGEST_SKIP}; docker save "$image" -o x.tar; done`
        )
      )
    ).toStrictEqual([
      `sample.yml job "checks" step "Save Docker images" does not take its images from ${IMAGE_LIST_COMMAND}`,
    ]);
  });

  it('reports a saving step whose job declares no stack mode', () => {
    expect(findingsOf(sampleWorkflow(DERIVED_SAVE, { jobMode: null }))).toStrictEqual([
      `sample.yml job "checks" step "Save Docker images" runs in a job that declares no ${ENV_MODE_VARIABLE}`,
    ]);
  });

  it('reports a list command pointed at another mode than its job declares', () => {
    expect(
      findingsOf(sampleWorkflow(DERIVED_SAVE.replace('with-env.ts', 'with-env.ts --env-mode e2e')))
    ).toStrictEqual([
      `sample.yml job "checks" step "Save Docker images" does not take its images from ${IMAGE_LIST_COMMAND}`,
      'sample.yml job "checks" step "Save Docker images" lists its images under a mode other than its job\'s',
    ]);
  });

  it('reports a step that sets its own stack mode over its job', () => {
    const workflow = sampleWorkflow(DERIVED_SAVE).replace(
      '        run: |',
      `        env:\n          ${ENV_MODE_VARIABLE}: e2e\n        run: |`
    );

    expect(findingsOf(workflow)).toStrictEqual([
      'sample.yml job "checks" step "Save Docker images" lists its images under a mode other than its job\'s',
    ]);
  });

  it('reports a save of the listed images that skips no digest reference', () => {
    expect(findingsOf(sampleWorkflow(DERIVED_SAVE.replace(DIGEST_SKIP, '')))).toStrictEqual([
      'sample.yml job "checks" step "Save Docker images" saves "$image" without first skipping a digest reference',
    ]);
  });

  it('reports a digest skip that comes after the save', () => {
    const late = DERIVED_SAVE.replace(`  ${DIGEST_SKIP}\n`, '').replace(
      'done',
      `${DIGEST_SKIP}\ndone`
    );

    expect(findingsOf(sampleWorkflow(late))).toStrictEqual([
      'sample.yml job "checks" step "Save Docker images" saves "$image" without first skipping a digest reference',
      'sample.yml job "checks" step "Save Docker images" skips an image other than a digest reference',
    ]);
  });

  it('reports a digest skip that tests a variable other than the one saved', () => {
    const other = DERIVED_SAVE.replace(DIGEST_SKIP, DIGEST_SKIP.replace('$image', '$listed'));

    expect(findingsOf(sampleWorkflow(other))).toStrictEqual([
      'sample.yml job "checks" step "Save Docker images" saves "$image" without first skipping a digest reference',
      'sample.yml job "checks" step "Save Docker images" skips an image other than a digest reference',
    ]);
  });

  it('does not count a digest skip a comment has swallowed', () => {
    expect(
      findingsOf(sampleWorkflow(DERIVED_SAVE.replace(DIGEST_SKIP, `# ${DIGEST_SKIP}`)))
    ).toStrictEqual([
      'sample.yml job "checks" step "Save Docker images" saves "$image" without first skipping a digest reference',
    ]);
  });

  it('reads a digest skip on a braced expansion', () => {
    const braced = DERIVED_SAVE.replace(DIGEST_SKIP, DIGEST_SKIP.replace('$image', '${image}'));

    expect(findingsOf(sampleWorkflow(braced))).toStrictEqual([]);
  });

  it('reports a second skip that drops an image other than a digest reference', () => {
    const extra = DERIVED_SAVE.replace(
      DIGEST_SKIP,
      `${DIGEST_SKIP}\n  if [[ "$image" == postgres* ]]; then continue; fi`
    );

    expect(findingsOf(sampleWorkflow(extra))).toStrictEqual([
      'sample.yml job "checks" step "Save Docker images" skips an image other than a digest reference',
    ]);
  });

  it('names a step by its position where the step carries no name', () => {
    expect(
      findingsOf(sampleWorkflow('docker save example/db:1 -o /tmp/db.tar', { stepName: null }))
    ).toStrictEqual([
      'sample.yml job "checks" step "step 0" saves example/db:1, an image written into the workflow',
      `sample.yml job "checks" step "step 0" does not take its images from ${IMAGE_LIST_COMMAND}`,
    ]);
  });
});
