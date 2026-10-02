/**
 * Compose resolves a service's relative bind-mount source against its project
 * directory before hashing the service, so the spelling a process reached the
 * checkout by decides that service's hash. These drive the real client over a
 * fixture project reached two ways, because what compose does with a path is
 * not something reading its flags establishes.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { beforeAll, describe, expect, it } from 'vitest';
import { CHECKOUT_DIRECTORY, composeArguments } from './compose.js';
import {
  parseComposeHashes,
  parseComposePs,
  servicesMatchConfig,
} from './lib/stack/compose-state.js';

/** The service whose hash moves with the spelling: the one with a relative mount. */
const SERVICE = 'mounted';

/**
 * Nothing interpolated and nothing pulled: `config --hash` parses the file and
 * hashes the service, so the image never has to exist and no daemon is asked
 * for anything.
 */
const PROJECT_FILE = `name: hushbox-compose-project-directory-fixture
services:
  ${SERVICE}:
    image: alpine
    volumes:
      - ./mounted.txt:/mounted.txt:ro
`;

/** The directory the fixture project lives in. */
let checkout: string;
/** A second absolute spelling of that same directory. */
let link: string;

/**
 * The hashes compose computes for a process that reached the project by
 * `spelling`. The working directory stays the one directory throughout and
 * only the inherited working-directory variable moves, because that variable
 * is what the client reads its own location from when the two agree on which
 * directory they name.
 */
async function hashesReachedBy(spelling: string): Promise<Map<string, string>> {
  const result = await execa('docker', composeArguments(spelling, ['config', '--hash', '*']), {
    cwd: checkout,
    env: { ...process.env, PWD: spelling },
  });
  return parseComposeHashes(result.stdout);
}

/** What `compose ps` reports for a container created from `hash`. */
function containerCreatedFrom(hash: string): ReturnType<typeof parseComposePs> {
  return parseComposePs(
    JSON.stringify({
      Service: SERVICE,
      State: 'running',
      Labels: `com.docker.compose.config-hash=${hash}`,
    })
  );
}

beforeAll(async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hushbox-compose-spelling-')));
  checkout = path.join(base, 'checkout');
  await mkdir(checkout);
  await writeFile(path.join(checkout, 'mounted.txt'), '');
  await writeFile(path.join(checkout, 'docker-compose.yml'), PROJECT_FILE);
  link = path.join(base, 'reached-through-a-link');
  await symlink(checkout, link, 'junction');
});

describe('the bring-up drift decision', () => {
  it('matches a container the other spelling of the checkout created', async () => {
    const broughtUpBy = await hashesReachedBy(checkout);
    const created = broughtUpBy.get(SERVICE);
    if (created === undefined) throw new Error(`compose computed no hash for ${SERVICE}`);

    expect(
      servicesMatchConfig([SERVICE], containerCreatedFrom(created), await hashesReachedBy(link))
    ).toBe(true);
  });
});

describe('a compose invocation', () => {
  it('names one spelling for a directory reached two ways', () => {
    const args = composeArguments(link, ['ps']);
    expect(args).toContain(checkout);
    expect(args).not.toContain(link);
  });

  it('carries the caller’s own words after the directory it pinned', () => {
    expect(composeArguments(checkout, ['ps', '--format', 'json']).slice(-3)).toEqual([
      'ps',
      '--format',
      'json',
    ]);
  });
});

/**
 * Against the filesystem rather than against the constant, which an argv
 * assertion compares to and so holds for any value it takes. The pinned
 * directory is also where compose looks for the compose file, so one without it
 * is a directory no call site can work from.
 */
describe('the checkout every invocation pins', () => {
  it('names the directory holding the repository’s compose file', () => {
    expect(existsSync(path.join(CHECKOUT_DIRECTORY, 'docker-compose.yml'))).toBe(true);
  });
});
