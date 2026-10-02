/**
 * Answers whether a push run's commit already shipped, so the run publishes
 * nothing a second time under another number. A release tag on the commit or
 * on a descendant means a release carrying this code was deployed and tagged.
 * Claims do not count: a claim reserves a number for a deploy that may never
 * ship.
 *
 * A dispatch always answers no, whatever the tags say: it is a human asking
 * for a deploy, and redeploying shipped code is one of the things they ask
 * for. Anything this cannot read fails the run rather than answering no.
 */
import { writeGithubOutput } from '../extract-version.js';
import { readCommandLine, type CommandSpec } from '../lib/cli/command-line.js';
import { isMainModule } from '../lib/cli/is-main.js';
import { runMain } from '../lib/cli/run-main.js';
import { git } from '../lib/publication/git.js';
import { RELEASE_TAGS, versionReferences } from './compute-next-version.js';

/** The key the answer is written under, which `.github/workflows/ci.yml`'s shipped job reads off its step. */
export const SHIPPED_OUTPUT = 'shipped';

export interface RunOptions {
  readonly repositoryRoot: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  return value;
}

/** The release tags on `sha` or a descendant, read after fetching every release tag `origin` carries. */
async function shippingTags(repositoryRoot: string, sha: string): Promise<string[]> {
  const releaseTags = `${RELEASE_TAGS}v*`;
  await git(repositoryRoot, ['fetch', '--quiet', 'origin', `+${releaseTags}:${releaseTags}`]);
  const containing = await versionReferences(git, repositoryRoot, [RELEASE_TAGS], sha);
  return containing.map((entry) => entry.tag);
}

export async function main(options: RunOptions): Promise<void> {
  const event = required('GITHUB_EVENT_NAME');
  const sha = required('GITHUB_SHA');
  required('GITHUB_OUTPUT');

  if (event === 'workflow_dispatch') {
    process.stdout.write('A dispatch always deploys, whatever release tags sit on its commit.\n');
    writeGithubOutput([`${SHIPPED_OUTPUT}=false`]);
    return;
  }
  if (event !== 'push') {
    throw new Error(`GITHUB_EVENT_NAME is "${event}"; only push and workflow_dispatch are judged`);
  }

  const tags = await shippingTags(options.repositoryRoot, sha);
  if (tags.length > 0) {
    process.stdout.write(
      `Already shipped: release ${tags.join(', ')} sits on this commit or a descendant.\n`
    );
    writeGithubOutput([`${SHIPPED_OUTPUT}=true`]);
    return;
  }
  process.stdout.write('No release tag sits on this commit or a descendant.\n');
  writeGithubOutput([`${SHIPPED_OUTPUT}=false`]);
}

export const COMMAND_LINE = {
  command: 'tsx scripts/release/deploy-shipped.ts',
  summary: 'Answers whether a release tag already sits on this push commit or a descendant.',
  flags: [],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI entry point, exercised through CI */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    if (readCommandLine(COMMAND_LINE, process.argv.slice(2)) === null) return;
    await main({ repositoryRoot: process.cwd() });
  });
}
/* v8 ignore stop */
