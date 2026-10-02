/**
 * What each panel on this page is scoped by, and the sentence it states about
 * the controls that do not reach it.
 *
 * The page draws its controls once, above everything, and each read answers to
 * a different subset of them. A panel a control does not reach looks exactly
 * like a panel it does — the figures simply do not move — so a reader who
 * narrowed the page has no way to tell a panel that honoured the narrowing from
 * one that ignored it. Each panel therefore states what it covers rather than
 * leaving that to be inferred from a number that did not change.
 *
 * The declaration is a required prop of the panel frame, so the question is put
 * to every panel drawn through it, including ones added later.
 */

/** Why a panel's figures cover every campaign rather than the selection. */
export type EveryCampaignReason =
  | 'one-at-a-time'
  | 'no-campaign-dimension'
  | 'edge-carries-no-campaign'
  | 'not-narrowed'
  | 'is-the-list';

/**
 * A limit that can hold of some of a panel's figures while the rest follow the
 * selection. Only a limit on a figure can: one on the read behind a panel
 * reaches everything that read answers with.
 */
export type SomeFiguresReason = Extract<EveryCampaignReason, 'one-at-a-time'>;

/**
 * Whether the page's campaign selection reaches a panel's figures — all of
 * them, none of them, or all but the ones named.
 *
 * The third state is a state of the panel rather than of the read behind it: a
 * panel drawing figures from more than one read is narrowed where one of them
 * is, and a panel declaring the whole of itself narrowed would be declaring a
 * scope the other figures have not got.
 */
export type CampaignScope =
  | { readonly kind: 'narrowed' }
  | { readonly kind: 'every-campaign'; readonly reason: EveryCampaignReason }
  | {
      readonly kind: 'narrowed-except';
      readonly reason: SomeFiguresReason;
      /** The figures it does not reach, under the names their tiles carry. */
      readonly unreached: readonly string[];
    };

/** The span a panel's figures cover, against the controls drawn above them. */
export type WindowScope =
  | { readonly kind: 'selected-week' }
  | { readonly kind: 'recent-weeks'; readonly weeks: number }
  | { readonly kind: 'recent-days'; readonly days: number }
  /**
   * A span an operator set both ends of. Named by its two days rather than as a
   * narrowing of the week picker: a range is not a week, so the clause states
   * what it covers instead of what it is not.
   */
  | { readonly kind: 'day-range'; readonly startDay: string; readonly endDay: string }
  | { readonly kind: 'unwindowed' };

/** A read carrying no campaign dimension, which the page's selection cannot reach. */
export const NO_CAMPAIGN_DIMENSION: CampaignScope = {
  kind: 'every-campaign',
  reason: 'no-campaign-dimension',
};

/** A read the page's campaign selection narrows. */
export const CAMPAIGN_NARROWED: CampaignScope = { kind: 'narrowed' };

/**
 * A panel stating how far the data reaches, which the selection cannot narrow:
 * the edge is a day rather than a count, and a day carries no campaign.
 */
export const DATA_EDGE_NO_CAMPAIGN: CampaignScope = {
  kind: 'every-campaign',
  reason: 'edge-carries-no-campaign',
};

/**
 * A panel the selection narrows except for the figures named — or, where it
 * names none, one the selection narrows whole.
 *
 * One constructor rather than a branch at each panel, so a panel cannot state
 * the partial limit over an empty list of figures, which would name none of
 * them while claiming some figure was left out.
 */
export function campaignNarrowedExcept(
  reason: SomeFiguresReason,
  unreached: readonly string[]
): CampaignScope {
  return unreached.length === 0
    ? CAMPAIGN_NARROWED
    : { kind: 'narrowed-except', reason, unreached };
}

/** A read asking for exactly the week the picker names. */
export const SELECTED_WEEK: WindowScope = { kind: 'selected-week' };

/** Which of the page's controls reach one panel. */
export interface PanelScope {
  readonly campaigns: CampaignScope;
  readonly window: WindowScope;
}

/**
 * One clause per reason, in one place: what the panel covers, why, and — where
 * there is one — what to do about it. Two panels phrasing the same limit
 * differently read as two different limits.
 */
const EVERY_CAMPAIGN_CLAUSES: Readonly<Record<EveryCampaignReason, string>> = {
  'one-at-a-time':
    'Counts every campaign, not the selection above: this read narrows to one campaign at a time. Select a single campaign to scope it.',
  'no-campaign-dimension':
    'Counts every campaign, not the selection above: these counts carry no campaign.',
  'edge-carries-no-campaign':
    'Covers every campaign, not the selection above: the edge of the data carries no campaign.',
  'not-narrowed':
    'Counts every campaign, not the selection above: the campaign column says which, and this read is not narrowed by the selection.',
  'is-the-list':
    'Lists every campaign, not the selection above: the selection scopes the panels, not this list.',
};

/**
 * The subject of each clause above: what the panel covers, short enough to sit
 * in the panel header beside its title. Beside the clauses rather than derived
 * from them, because a sentence's subject is not a prefix of it.
 */
const EVERY_CAMPAIGN_SUBJECTS: Readonly<Record<EveryCampaignReason, string>> = {
  'one-at-a-time': 'One campaign at a time',
  'no-campaign-dimension': 'Every campaign',
  'edge-carries-no-campaign': 'Every campaign',
  'not-narrowed': 'Every campaign',
  'is-the-list': 'Every campaign',
};

/**
 * The same limits where one holds of some of a panel's figures and not the
 * rest, beside the table above so that a limit's two states are written as one
 * limit rather than two.
 *
 * The figures are named in the clause because the reader is looking at several
 * of them: a sentence stating that the selection misses something, over a panel
 * that does not say which, leaves every figure on it in doubt.
 */
const SOME_FIGURES_CLAUSES: Readonly<Record<SomeFiguresReason, (figures: string) => string>> = {
  'one-at-a-time': (figures) =>
    `The selection above reaches every figure here but ${figures}, which count every campaign: a count of distinct visitors narrows to one campaign at a time. Select a single campaign to scope them.`,
};

/**
 * The figures a scope declaration names, joined so the list reads as one: the
 * names carry commas of their own, which a comma-joined list would be read as
 * more of. Shared with the exported file's own declaration, so a figure list
 * reads the same way on the screen and in the file that outlives it.
 */
export function namedFigures(figures: readonly string[]): string {
  return figures.join(' and ');
}

/**
 * One limit a panel states: the part a reader takes in at a glance, and the
 * whole sentence behind it.
 *
 * Both halves come off the same declaration, so a panel cannot show a subject
 * whose clause says something else, and a limit that earns a clause earns a
 * subject with it.
 */
export interface ScopeChip {
  /** What the limit covers, which is what a reader sees without interacting. */
  readonly subject: string;
  /** What the panel covers, why, and — where there is one — what to do about it. */
  readonly clause: string;
}

/**
 * What a panel shows and says about the campaigns its figures cover, or
 * nothing where the selection reaches them all.
 *
 * The four every-campaign reasons share a subject because they state the same
 * coverage and differ only in why; the reason is what the clause adds. The
 * partial limit does not share it: a panel whose selection misses some figures
 * and not others names them where they are read, because a limit over a panel
 * that does not say which figures it holds of leaves every figure on it in
 * doubt.
 */
function campaignChip(scope: CampaignScope): ScopeChip | null {
  switch (scope.kind) {
    case 'narrowed': {
      return null;
    }
    case 'every-campaign': {
      return {
        subject: EVERY_CAMPAIGN_SUBJECTS[scope.reason],
        clause: EVERY_CAMPAIGN_CLAUSES[scope.reason],
      };
    }
    case 'narrowed-except': {
      const figures = namedFigures(scope.unreached);
      return {
        subject: `Every campaign: ${figures}`,
        clause: SOME_FIGURES_CLAUSES[scope.reason](figures),
      };
    }
  }
}

/** What a panel shows and says about the span it covers, or nothing where the week picker reaches it. */
function windowChip(scope: WindowScope): ScopeChip | null {
  switch (scope.kind) {
    case 'selected-week': {
      return null;
    }
    case 'recent-weeks': {
      return {
        subject: `Last ${String(scope.weeks)} weeks`,
        clause: `Covers the last ${String(scope.weeks)} weeks, not the week selected above.`,
      };
    }
    case 'recent-days': {
      return {
        subject: `Last ${String(scope.days)} days`,
        clause: `Covers the last ${String(scope.days)} days, not the week selected above.`,
      };
    }
    case 'day-range': {
      return {
        subject: `${scope.startDay} to ${scope.endDay}`,
        clause: `Covers ${scope.startDay} to ${scope.endDay}, the range set above.`,
      };
    }
    case 'unwindowed': {
      return {
        subject: 'Every week',
        clause: 'Not limited to the week selected above.',
      };
    }
  }
}

/**
 * The limits a panel states, one per control that does not reach it, or none
 * where both do — a panel the controls govern states nothing, because there the
 * moving figures are the statement.
 */
export function panelScopeChips(scope: PanelScope): readonly ScopeChip[] {
  return [campaignChip(scope.campaigns), windowChip(scope.window)].filter((chip) => chip !== null);
}

/**
 * The whole of what a panel states about the controls that do not reach it, or
 * null when both of them do. The chips' own clauses rather than a second
 * phrasing of them, so the sentence a reader hears and the sentence behind a
 * chip cannot come apart.
 */
export function panelScopeNote(scope: PanelScope): string | null {
  const chips = panelScopeChips(scope);
  return chips.length === 0 ? null : chips.map((chip) => chip.clause).join(' ');
}
