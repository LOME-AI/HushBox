import type { FindingJson, Question } from '@hushbox/docket';

/** A question nobody has answered, which is what puts a finding in the questions section. */
export function makeQuestion(overrides: Partial<Question> = {}): Question {
  return {
    at: '2026-07-30',
    text: 'Which slice owns this?',
    answer: null,
    answered_at: null,
    ...overrides,
  };
}

/**
 * A finding as the API hands it to the client. `searchText` defaults to the
 * same fields the server derives it from, so a test that overrides a title
 * still searches the way the real payload does.
 */
export function makeFinding(overrides: Partial<FindingJson> & { id: string }): FindingJson {
  const base = {
    title: `Title for ${overrides.id}`,
    titleHtml: overrides.title ?? `Title for ${overrides.id}`,
    severity: 'medium',
    kind: 'defect',
    status: 'live',
    statusNote: null,
    area: 'apps/api',
    needsRuling: true,
    needsOptions: false,
    warning: false,
    related: [],
    group: null,
    dedicated: false,
    state: 'open',
    ruling: null,
    denial: null,
    history: [],
    questions: [],
    progress: { status: 'not-started', updated: null, verified: false, notes: [] },
    options: [],
    bodyHtml: '<p>Body</p>',
    path: `docs/audits/2026-07-30/findings/${overrides.id}.md`,
    hash: 'hash',
  } satisfies Omit<FindingJson, 'id' | 'searchText'>;

  const merged = { ...base, ...overrides };
  // The server renders one reading out of the other, so a payload whose markup
  // does not read back as its title cannot exist. A caller spreading a finding
  // and rewriting only its title would otherwise get one, and the surfaces that
  // place a title as markup would show the title it used to have.
  const titleHtml =
    merged.titleHtml.replaceAll(/<[^>]+>/gu, '') === merged.title ? merged.titleHtml : merged.title;
  return {
    ...merged,
    titleHtml,
    searchText:
      overrides.searchText ??
      [merged.id, merged.title, merged.area, merged.group ?? ''].filter(Boolean).join('\n'),
  };
}
