import { DashboardPane } from './dashboard/dashboard-pane';
import { DeniedPane } from './denied/denied-pane';
import { ProgressBoard } from './progress/progress-board';
import { QuestionsLead } from './questions/questions-lead';
import { RuledPane } from './ruled/ruled-pane';
import type { SectionId } from '@/components/shell/logic/sections';
import type { FindingJson } from '@hushbox/docket';
import type { JSX } from 'react';

/**
 * What a pane is given to act with. It arrives as one object rather than a
 * growing argument list so that a pane needing a new capability does not
 * re-thread every other pane's signature through the shell.
 */
export interface PaneDeps {
  /** Takes the finding a write produced, wherever the reader is. */
  readonly put: (finding: FindingJson) => void;
  /** Sends the reader to another section, as the section nav does. */
  readonly go: (section: SectionId) => void;
  /**
   * Says when a pane has a bulk ruling plan working its way down the queue, for
   * the controls above the pane that wait on one.
   */
  readonly onBulkRunning: (running: boolean) => void;
}

type PaneBody = (findings: readonly FindingJson[]) => JSX.Element;

/**
 * A review list also needs the finding the url names, so it can mark it and
 * scroll to it. `focus` is required rather than optional on purpose: an optional
 * one is assignable to a caller that never passes it, so the value could stop
 * arriving and every gate would stay green. Required, that same narrowing is a
 * compile error.
 */
type PaneListBody = (findings: readonly FindingJson[], focus: string | null) => JSX.Element;

type PaneRenderers = Partial<Record<SectionId, (deps: PaneDeps) => PaneBody>>;

type PaneListRenderers = Partial<Record<SectionId, (deps: PaneDeps) => PaneListBody>>;

/**
 * Two sections are not a queue of findings at all and replace both modes; every
 * other section falls through to the pane's list and focus modes.
 */
const BODIES: PaneRenderers = {
  dashboard:
    ({ go }) =>
    (findings) => <DashboardPane findings={findings} onSection={go} />,
  progress:
    ({ put }) =>
    (findings) => <ProgressBoard findings={findings} put={put} />,
};

/**
 * A review list replaces the rows in list mode and leaves focus mode alone, so
 * the finding card stays reachable in every section that is a state's queue.
 * That is load-bearing rather than cosmetic: the card is where a write refusal
 * is reported, including a refused undo that lands the reader here.
 */
const LISTS: PaneListRenderers = {
  ruled:
    ({ put }) =>
    (findings, focus) => <RuledPane findings={findings} put={put} focus={focus} />,
  denied:
    ({ put }) =>
    (findings, focus) => <DeniedPane findings={findings} put={put} focus={focus} />,
};

/**
 * A lead sits above a section's queue instead of replacing it, so a section can
 * carry pane-level work and still be the ruling queue underneath.
 */
const LEADS: PaneRenderers = {
  questions:
    ({ put, onBulkRunning }) =>
    (findings) => <QuestionsLead findings={findings} put={put} onBulkRunning={onBulkRunning} />,
};

export function paneBody(section: SectionId, deps: PaneDeps): PaneBody | undefined {
  return BODIES[section]?.(deps);
}

export function paneLead(section: SectionId, deps: PaneDeps): PaneBody | undefined {
  return LEADS[section]?.(deps);
}

export function paneList(section: SectionId, deps: PaneDeps): PaneListBody | undefined {
  return LISTS[section]?.(deps);
}
