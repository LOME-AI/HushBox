import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule, { ANCHOR_MAP } from './declared-route-keys-match-disjoint-paths.rule.js';

/** A declaration map holding the given route keys, in the shape a fragment writes. */
function map(...keys: readonly string[]): string {
  const entries = keys.map((key) => `  '${key}': { kind: 'default', failure: 'open' },`);
  return `export const POSTURES = {\n${entries.join('\n')}\n};\n`;
}

/**
 * The anchor is seeded unless a case supplies its own, so every case exercises
 * the check rather than the rule's own subject assertion. `/health` is one
 * literal segment and shares no shape with any fixture below.
 */
function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  if (!Object.hasOwn(files, ANCHOR_MAP)) {
    project.createSourceFile(ANCHOR_MAP, map('$get /health'));
  }
  for (const [filePath, source] of Object.entries(files)) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

const FRAGMENT = 'apps/api/src/slices/conversations/rate-limit-posture.ts';
const OTHER_FRAGMENT = 'apps/api/src/slices/chat/rate-limit-posture.ts';

describe('declared-route-keys-match-disjoint-paths', () => {
  it('accepts the tree as it stands, where no two declared keys share a path', () => {
    const project = projectWith({
      [FRAGMENT]: map('$get /conversations/:conversationId', '$get /conversations/shared/links'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a literal declared beside a param it fits, naming both keys and the path', () => {
    const project = projectWith({
      [FRAGMENT]: map('$get /conversations/:conversationId', '$get /conversations/shared'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/\$get \/conversations\/:conversationId/);
    expect(violations[0]?.message).toMatch(/\$get \/conversations\/shared/);
    expect(violations[0]?.message).toMatch(/\/conversations\/shared/);
  });

  it('flags the overlap a probe path per template cannot reveal', () => {
    const project = projectWith({
      [FRAGMENT]: map('$get /a/:x/b', '$get /a/c/:y'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('/a/c/b');
  });

  it('reports a placeholder where both templates leave the segment open', () => {
    const project = projectWith({
      [FRAGMENT]: map('$get /x/:first', '$get /x/:second'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('/x/{any}');
  });

  it('accepts two templates whose literal segments differ', () => {
    const project = projectWith({
      [FRAGMENT]: map('$get /x/one', '$get /x/two'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a longer template beside a shorter one', () => {
    const project = projectWith({
      [FRAGMENT]: map('$get /x/:id', '$get /x/y/z'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a shorter template beside a longer one', () => {
    const project = projectWith({
      [FRAGMENT]: map('$get /x/y/z', '$get /x/:id'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts one path reached under two different methods', () => {
    const project = projectWith({
      [FRAGMENT]: map('$get /x/:id', '$post /x/literal'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('counts a key declared in two route-keyed maps once', () => {
    const project = projectWith({
      [FRAGMENT]: map('$get /x/:id'),
      [OTHER_FRAGMENT]: map('$get /x/:id'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('counts a key declared twice in one file once', () => {
    const project = projectWith({
      [FRAGMENT]: `${map('$get /x/:id')}\n${map('$get /x/:id')}`,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('reports the overlap at a declaration site inside the scanned tree', () => {
    const project = projectWith({
      [FRAGMENT]: map('$get /conversations/:conversationId', '$get /conversations/shared'),
    });

    expect(rule.check(project)[0]).toMatchObject({ file: FRAGMENT, line: expect.any(Number) });
  });

  it('refuses a wildcard segment rather than deciding it', () => {
    const project = projectWith({
      [FRAGMENT]: map('$get /x/*'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('*');
  });

  it('refuses an optional param', () => {
    const project = projectWith({
      [FRAGMENT]: map('$get /x/:id?'),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('refuses a regex-constrained param', () => {
    const project = projectWith({
      [FRAGMENT]: map('$get /x/:id{[0-9]+}'),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('refuses an undecidable segment once, without also pairing the key it sits in', () => {
    const project = projectWith({
      [FRAGMENT]: map('$get /x/*', '$get /x/literal'),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('accepts a param segment spelled with an underscore and a digit', () => {
    const project = projectWith({
      [FRAGMENT]: map('$get /x/:id_2/y'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('reads no test file, which asserts over route keys rather than declaring them', () => {
    const project = projectWith({
      [FRAGMENT.replace('.ts', '.test.ts')]: map(
        '$get /conversations/:conversationId',
        '$get /conversations/shared'
      ),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('leaves trees outside the product Worker alone', () => {
    const project = projectWith({
      'apps/web/src/lib/route-keys.ts': map(
        '$get /conversations/:conversationId',
        '$get /conversations/shared'
      ),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes over property names that are not route keys', () => {
    const project = projectWith({
      [FRAGMENT]: [
        'export const NOT_ROUTES = {',
        "  'kind': 'default',",
        "  '$get': 'no path',",
        "  'get /conversations/shared': 'no verb marker',",
        '  identifier: 1,',
        '};',
        '',
      ].join('\n'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('refuses to run when the anchor map names no file', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(FRAGMENT, map('$get /x/:id'));

    expect(() => rule.check(project)).toThrow(ANCHOR_MAP);
  });

  it('refuses to run when the anchor map declares no route key', () => {
    const project = projectWith({
      [ANCHOR_MAP]: "export const APP_ROUTE_POSTURES = { kind: 'exempt' };\n",
      [FRAGMENT]: map('$get /x/:id'),
    });

    expect(() => rule.check(project)).toThrow(ANCHOR_MAP);
  });
});
