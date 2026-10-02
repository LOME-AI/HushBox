import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  HOST_PATH_ENVELOPE_GUARD_SOURCE,
  NAMED_HOME_SOURCE,
  ROOTED_HOST_PATH_SOURCE,
  rootedHostPathSource,
  withoutHostPaths,
} from './host-paths.js';
import { scanTextBlobs } from './rules.js';

/**
 * Specimens are assembled from parts at runtime for the reason the binary
 * gate's own suite states: a host path written down here would be the value
 * the gates detect, and no allowlist entry may admit one.
 */
const hostPath = (...segments: readonly string[]): string => ['', ...segments].join('/');
const tildeHome = (name: string, ...segments: readonly string[]): string =>
  [`~${name}`, ...segments].join('/');

const bare = (source: string): RegExp => new RegExp(source, 'u');
const composed = (source: string): RegExp =>
  new RegExp(`${HOST_PATH_ENVELOPE_GUARD_SOURCE}(?:${source})`, 'u');

describe('the host-path vocabulary is a leaf', () => {
  it('imports nothing, so no importer of it can close a cycle', () => {
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'host-paths.ts'),
      'utf8'
    );
    expect(source).not.toMatch(
      /(?:^\s*import\b)|(?:\bfrom\s*['"])|(?:\b(?:require|import)\s*\()/mu
    );
  });
});

describe('HOST_PATH_ENVELOPE_GUARD_SOURCE', () => {
  it('refuses a rooted spelling the bare source reads at an inner segment', () => {
    const inner = hostPath('srv', 'home', 'someone');
    expect(bare(ROOTED_HOST_PATH_SOURCE).test(inner)).toBe(true);
    expect(composed(ROOTED_HOST_PATH_SOURCE).test(inner)).toBe(false);
  });

  it('refuses a shorthand spelling the bare source reads after a word character', () => {
    const inner = `build${tildeHome('someone', 'project')}`;
    expect(bare(NAMED_HOME_SOURCE).test(inner)).toBe(true);
    expect(composed(NAMED_HOME_SOURCE).test(inner)).toBe(false);
  });
});

describe('rootedHostPathSource', () => {
  it('gates the system temp root on a digit run when asked to', () => {
    const digitless = hostPath('tmp', 'scratch', 'frame.png');
    expect(bare(rootedHostPathSource({ tempRootNeedsDigitRun: true })).test(digitless)).toBe(false);
    expect(bare(rootedHostPathSource({ tempRootNeedsDigitRun: false })).test(digitless)).toBe(true);
  });

  it('is the exported rooted source when the temp gate is on', () => {
    expect(rootedHostPathSource({ tempRootNeedsDigitRun: true })).toBe(ROOTED_HOST_PATH_SOURCE);
  });
});

/**
 * The rule that decides what the gate may print, swept as a rule rather than as
 * the cases someone happened to hit. Every fixture here is written out rather
 * than derived from the machine running the suite: a path built from the system
 * temp directory exercises whichever shape that machine happens to use, which is
 * how this class stayed pinned on one member across repeated reviews.
 */
describe('withoutHostPaths', () => {
  const windowsTail = (segments: readonly string[]): string =>
    segments.map((segment) => `\\${segment}`).join('');
  const windows = (drive: string, ...segments: readonly string[]): string =>
    `${drive}:` + windowsTail(segments);
  const unc = (...segments: readonly string[]): string => '\\' + windowsTail(segments);
  const quoted = (subject: string): string => `fatal: cannot change to '${subject}'`;

  it.each([
    ['a posix clone path', `${quoted(hostPath('home', 'someone', 'box'))}: No such file`],
    [
      'a home directory containing a space',
      `fatal: not a git repository: '${hostPath('home', 'Jane Smith', 'box', '.git')}'`,
    ],
    ['a windows path at the bottom of the drive band', quoted(windows('A', 'Users', 'someone'))],
    ['a windows path at the top of the drive band', quoted(windows('Z', 'Users', 'someone'))],
    ['a lowercase drive letter', quoted(windows('c', 'Users', 'someone'))],
    ['a UNC share', quoted(unc('build-01', 'share', 'box'))],
    [
      'a bare path with no quoting',
      `fatal: unable to read ${hostPath('var', 'lib', 'someone', 'box')}`,
    ],
    [
      'an scp-style location, account and all',
      `fatal: could not read from agent@build-01:${hostPath('srv', 'clones', 'box')}`,
    ],
    ['an address with no path after it', 'fatal: authentication failed for someone@build-01'],
    [
      'a path introduced by a separator rather than a space',
      `fatal: repository=${hostPath('home', 'someone', 'box')}`,
    ],
    // The positions a git diagnosis introduces a path from, pinned as fixtures
    // rather than as a list that could be read back off the pattern: the guard in
    // front of every alternative names the characters a path may *not* start
    // after, so there is no membership to enumerate, and the containment
    // invariant over the content gate's spellings sweeps the positions these
    // fixtures do not name.
    ['a path at the very start of the message', `${hostPath('home', 'someone', 'box')}: not found`],
    ['a path after an opening paren', `fatal: (${hostPath('home', 'someone', 'box')})`],
    ['a path after a colon', `fatal: repository:${hostPath('home', 'someone', 'box')}`],
    ['a path after a double quote', `fatal: cannot read "${hostPath('home', 'someone', 'box')}"`],
    [
      'a home directory written in the shorthand that names no root',
      quoted(`${tildeHome('someone', 'box')}/`),
    ],
    [
      'a rooted path a bracket introduces',
      `fatal: index [${hostPath('home', 'someone', 'box')}] is stale`,
    ],
  ])('redacts %s', (_name, message) => {
    const scrubbed = withoutHostPaths(message);
    for (const secret of ['someone', 'Jane', 'Smith', 'Users', 'build-01', 'box', 'agent', 'srv']) {
      expect(scrubbed).not.toContain(secret);
    }
    expect(scrubbed).toContain('<path>');
  });

  it('takes the drive letter with the path it introduces', () => {
    // Without this the drive band is unobservable: a colon-started match redacts
    // the tail either way, so both ends of `[A-Za-z]` survive being moved.
    for (const drive of ['A', 'Z', 'c']) {
      expect(withoutHostPaths(quoted(windows(drive, 'Users', 'someone')))).not.toContain(
        `${drive}:`
      );
    }
  });

  it('keeps the diagnosis a developer needs', () => {
    expect(withoutHostPaths(quoted(hostPath('home', 'someone', 'box')))).toContain(
      'fatal: cannot change to'
    );
  });

  it('leaves a ref name alone, which names no machine', () => {
    const ref = ['refs', 'heads', 'feature'].join('/');
    expect(withoutHostPaths(`fatal: bad object ${ref}`)).toBe(`fatal: bad object ${ref}`);
  });

  it('leaves a message with nothing to redact exactly as it is', () => {
    expect(withoutHostPaths('fatal: bad object HEAD')).toBe('fatal: bad object HEAD');
  });
});

/**
 * The containment between the two languages this repository reads a host path
 * in, asserted one way only. Whatever the content gate calls a machine name,
 * the redactor blanks — because a disclosure the gate refuses to let into a
 * file must not reach a committed error message either. The reverse is required
 * to differ: the redactor reads far more, since over-redaction costs a message
 * its trailing words and under-redaction costs a person their name.
 */
describe('the redactor reads every spelling the content gate calls a machine name', () => {
  const gateShapes = (text: string): readonly string[] =>
    scanTextBlobs([{ path: 'stderr.txt', bytes: Buffer.from(text, 'utf8') }], [])
      .filter((finding) => finding.rule === 'absolute-host-path')
      .map((finding) => finding.shape);

  const spellings = [
    hostPath('home', 'someone', 'box'),
    hostPath('Users', 'someone', 'box'),
    hostPath('workspace', 'someone', 'box'),
    hostPath('opt', 'someone', 'box'),
    hostPath('tmp', 'build-40312', 'frame.png'),
    hostPath('var', 'folders', 'q7', 'sandbox'),
    `C:${['', 'Users', 'someone'].join('\\')}`,
    `${tildeHome('someone', 'box')}/`,
  ];
  // Each envelope introduces the spelling from a different character. The gate's
  // guard admits every character that is not a word character, a dot or a tilde,
  // so a redactor whose own start condition were a list of characters instead
  // would go silent on whichever of these the list forgot.
  const envelopes = [
    (subject: string): string => `fatal: ${subject}`,
    (subject: string): string => `fatal: cannot change to '${subject}'`,
    (subject: string): string => `fatal: (${subject})`,
    (subject: string): string => `fatal: index [${subject}] is stale`,
    (subject: string): string => `fatal: repository=${subject}`,
    (subject: string): string => `fatal: <${subject}>`,
    (subject: string): string => `fatal: read|${subject}, giving up`,
  ];

  it.each(spellings.flatMap((spelling) => envelopes.map((wrap) => [wrap(spelling)] as const)))(
    'blanks the machine name in %s',
    (message) => {
      expect(
        gateShapes(message).length,
        'this specimen names no machine to the content gate, so the containment it claims to exercise is vacuous'
      ).toBeGreaterThan(0);
      expect(
        gateShapes(withoutHostPaths(message)),
        'the content gate reads a machine name here that the redactor left standing, so this spelling reaches a committed error message intact. The redactor is the deficient side and is what must widen'
      ).toEqual([]);
    }
  );

  it('introduces the subject from a different character in every envelope', () => {
    // Derived by applying the wrappers, never read off a list beside them: a list
    // is the same claim one level up, free to drift from the wrappers exactly as
    // the comment that states this property on `envelopes` did.
    const subject = '\u0000subject\u0000';
    const shapes = envelopes.map((wrap) => wrap(subject));
    const introducers = shapes.map((shape) => shape.slice(0, shape.indexOf(subject)).slice(-1));
    const collisions = shapes
      .filter((_shape, index) =>
        introducers.some(
          (introducer, other) => other !== index && introducer === introducers[index]
        )
      )
      .map((shape) => shape.replaceAll(subject, '<subject>'));
    expect(
      collisions,
      'these envelopes introduce the subject from the same character, so the axis repeats a start position and leaves whichever position each duplicate replaced unexercised'
    ).toEqual([]);
  });
});
