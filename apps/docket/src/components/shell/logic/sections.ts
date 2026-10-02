import { hasOutstandingQuestion } from '@hushbox/docket/types';
// Relative, not `@/`: three resolvers load this file — Vite for the browser
// build, tsx for the CLI, and knip's plain-Node config loader, which reaches it
// through vite.config.ts and has no alias because Vite's own `resolve.alias`
// is not active while the config is still being loaded.
import { isBlocked } from '../../decided-work.ts';
import type { FindingJson, FindingState } from '@hushbox/docket';

export const SECTION_IDS = [
  'dashboard',
  'open',
  'questions',
  'blocked',
  'dedicated',
  'ruled',
  'denied',
  'progress',
] as const;
export type SectionId = (typeof SECTION_IDS)[number];

/**
 * What deciding a finding's queue actually reads. Narrower than `FindingJson`
 * on purpose: the console's render shape carries markup it can only build in a
 * browser, and the CLI places findings read straight out of the store. Both
 * shapes carry these fields, so both are answerable by one predicate
 * rather than by a second copy written against the other shape.
 */
export type SectionFinding = Pick<FindingJson, 'state' | 'progress' | 'questions' | 'dedicated'>;

export interface SectionSpec {
  readonly id: SectionId;
  readonly label: string;
  /**
   * The state a finding is in while this section is its home: where a landing
   * puts it, and the yardstick for whether a write moved it out of the queue.
   */
  readonly state: FindingState;
  /** Whether a finding belongs in this section, which is not always its state. */
  readonly holds: (finding: SectionFinding) => boolean;
  /** Reads every finding the filters admit rather than one state's queue. */
  readonly wholeAudit: boolean;
  readonly emptyTitle: string;
  readonly emptyDescription: string;
}

/**
 * An undecided finding waiting on an answer is blocked, so it leaves the ruling
 * queue rather than sitting there reading as actionable, and is worked in the
 * questions section instead.
 *
 * A decided finding is the opposite case and keeps its section: it genuinely is
 * ruled, or genuinely is denied, and a later question about it is a separate
 * fact. Dropping one out of Ruled would take it out of the implementation
 * handoff, and dropping one out of Denied would make a decision disappear from
 * the record because somebody asked a follow-up.
 */
function unblockedIn(state: FindingState): (finding: SectionFinding) => boolean {
  return (finding) => finding.state === state && !hasOutstandingQuestion(finding);
}

function inState(state: FindingState): (finding: SectionFinding) => boolean {
  return (finding) => finding.state === state;
}

/**
 * The one case where leaving the implementation handoff is the point rather than
 * the cost: a ruling an agent could not carry out is contested, and going on
 * offering it to the next implementer is what the Blocked queue exists to stop.
 */
function movingIn(state: FindingState): (finding: SectionFinding) => boolean {
  return (finding) => finding.state === state && !isBlocked(finding);
}

/**
 * A finding too large for one task, or owed a design session before code, is
 * read from the Dedicated queue and is taken out of the queues an ordinary task
 * picks work up from. Blocked keeps it: a block outranks the disposition for
 * attention, and dual membership already has precedent in Questions.
 */
function undedicated(
  holds: (finding: SectionFinding) => boolean
): (finding: SectionFinding) => boolean {
  return (finding) => !finding.dedicated && holds(finding);
}

/**
 * Finished work leaves the queues work is picked up from — Open, Ruled and
 * Dedicated — because a finding somebody has already carried out is not work
 * anybody can take. It stays on the surfaces that exist to observe it: Progress
 * is where a done finding is read, and Denied keeps its own record whatever was
 * done against it. The line is `done` rather than `verified` so an agent's own
 * report clears the queue; the human's sign-off is a separate fact, tracked on
 * the progress board.
 */
function unfinished(
  holds: (finding: SectionFinding) => boolean
): (finding: SectionFinding) => boolean {
  return (finding) => finding.progress.status !== 'done' && holds(finding);
}

/**
 * Progress is a second view of the ruled set rather than a state of its own:
 * work can only be tracked on a finding that carries a ruling, so the two
 * sections read the same findings through different lenses.
 */
const SPECS: Record<SectionId, SectionSpec> = {
  dashboard: {
    id: 'dashboard',
    label: 'Dashboard',
    // Unread here: a whole-audit section is not a queue. The field stays typed
    // as one member so every queue section can hand it straight on.
    state: 'open',
    holds: inState('open'),
    wholeAudit: true,
    emptyTitle: 'This audit holds nothing',
    emptyDescription: 'No finding file was found in the audit directory.',
  },
  open: {
    id: 'open',
    label: 'Open',
    state: 'open',
    holds: undedicated(unfinished(unblockedIn('open'))),
    wholeAudit: false,
    emptyTitle: 'Nothing left to rule',
    emptyDescription: 'Every finding in this audit carries a ruling or a denial.',
  },
  questions: {
    id: 'questions',
    label: 'Questions',
    // Not a state: membership is derived from whether an answer is still owed.
    // The state below is only what a write is measured against for whether it
    // moved the finding, and an unanswered question decides nothing.
    state: 'open',
    holds: hasOutstandingQuestion,
    wholeAudit: false,
    emptyTitle: 'No questions in flight',
    emptyDescription: 'A finding you ask about waits here until the answer comes back.',
  },
  blocked: {
    id: 'blocked',
    label: 'Blocked',
    state: 'ruled',
    holds: isBlocked,
    wholeAudit: false,
    emptyTitle: 'Nothing is stuck',
    emptyDescription: 'A ruling an agent could not carry out waits here for you.',
  },
  ruled: {
    id: 'ruled',
    label: 'Ruled',
    state: 'ruled',
    holds: undedicated(unfinished(movingIn('ruled'))),
    wholeAudit: false,
    emptyTitle: 'No rulings yet',
    emptyDescription: 'Findings you rule collect here.',
  },
  dedicated: {
    id: 'dedicated',
    label: 'Dedicated',
    // Not a state: a marked finding is read from here whether or not it has been
    // ruled, because this queue is the inventory a session is planned from. The
    // state below is only what a write is measured against for whether it moved
    // the finding, and a mark is not a decision.
    state: 'open',
    holds: unfinished((finding) => finding.dedicated),
    wholeAudit: false,
    emptyTitle: 'Nothing needs a session',
    emptyDescription: 'A finding too large for one task, or owed a design first, waits here.',
  },
  denied: {
    id: 'denied',
    label: 'Denied',
    state: 'denied',
    holds: inState('denied'),
    wholeAudit: false,
    emptyTitle: 'Nothing denied',
    emptyDescription: 'Findings you refuse, and the ones the audit refuted, collect here.',
  },
  progress: {
    id: 'progress',
    label: 'Progress',
    state: 'ruled',
    holds: inState('ruled'),
    wholeAudit: false,
    emptyTitle: 'Nothing to track',
    emptyDescription: 'Implementation progress appears once a finding is ruled.',
  },
};

export const SECTIONS: readonly SectionSpec[] = SECTION_IDS.map((id) => SPECS[id]);

export function isSectionId(value: unknown): value is SectionId {
  return typeof value === 'string' && Object.hasOwn(SPECS, value);
}

export function sectionSpec(id: SectionId): SectionSpec {
  return SPECS[id];
}
