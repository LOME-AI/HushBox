import { useCallback, useMemo, useRef, useState } from 'react';
import { Toaster } from '@hushbox/ui';
import { AuditAddressProvider } from '@/api/audit-address';
import { useAuditEvents } from '@/hooks/use-audit-events';
import { useSearchState } from '@/hooks/use-search-state';
import { SourcePeek } from '@/components/source-peek/source-peek';
import { FindingCard } from '@/components/finding/finding-card';
import { FindingPalette } from '@/components/finding/finding-palette';
import { PromptDraftAudit } from '@/components/finding/prompt-form';
import { jumpTo, landTo } from '@/components/finding/logic/jump';
import { useFindingStore } from '@/components/finding/hooks/use-finding-store';
import { paneBody, paneLead, paneList } from '@/components/panes/pane-body';
import { ShortcutLegend } from '@/components/shortcut-legend';
import { TEST_IDS } from '@/test-ids';
import { ArrivalNotice } from './arrival-notice';
import { ConsoleHeader } from './console-header';
import { FilterRail } from './filter-rail';
import { SectionPane } from './section-pane';
import { ValidationBanner } from './validation-banner';
import { useArrival } from './logic/arrival';
import { focusSearch } from './logic/focus-search';
import { landAnnouncement, stepAnnouncement, stepFrom, currentIn } from './logic/queue-step';
import { useConsoleHotkeys } from './hooks/use-console-hotkeys';
import { useScrollRestore } from './hooks/use-scroll-restore';
import { useStepFocus } from './hooks/use-step-focus';
import {
  EMPTY_FILTERS,
  areaFilterOptions,
  countBySection,
  decidedCount,
  filterFindings,
  findingsInSection,
  isFiltering,
} from './logic/filters';
import { sectionSpec } from './logic/sections';
import type { Snapshot } from '@/server/audit-service';
import type { SectionId } from './logic/sections';
import type { JSX } from 'react';

/**
 * The console frame: what is being ruled, what is in view, and where in the
 * audit the reader is. Every pane reads the same filtered set, so a narrowed
 * queue narrows the tab counts with it.
 */
export function ConsoleShell({
  snapshot,
  onAudit,
}: Readonly<{
  snapshot: Snapshot;
  /**
   * Where a chosen audit goes. The shell is what a switch replaces, so the
   * audit being read is held above it: this hands the choice up to whoever
   * reissues the read.
   */
  onAudit: (name: string) => void;
}>): JSX.Element {
  const { state, audit, update, setFilters, switchAudit } = useSearchState();
  const { mode } = state;
  // What every request below here is addressed to: the audit the reader asked
  // for, or — on a url that names none — the one the server chose to serve.
  const address = audit ?? snapshot.name;
  const { findings, put } = useFindingStore(snapshot.findings);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const [live, setLive] = useState(true);
  // A bulk ruling plan belongs to the pane that runs it, and the control that
  // waits on one sits in the header: the shell is the lowest place that sees
  // both, so it is where the pane reports and the header reads.
  const [bulkRunning, setBulkRunning] = useState(false);
  const [stepped, setStepped] = useState('');
  // The keyboard's steps only. The pane's step buttons move the reader the same
  // way, and taking focus off the button they pressed would stop the next press.
  const [keyboardSteps, setKeyboardSteps] = useState(0);
  const paneRef = useRef<HTMLElement>(null);
  // A write made outside the console patches the card it names, in place.
  useAuditEvents({ audit: address, onFinding: put, onLive: setLive });

  const section = sectionSpec(state.section);
  // Memoized because a search keystroke re-runs this over the whole audit and
  // re-renders every row that survives it.
  const filtered = useMemo(
    () => filterFindings(findings, state.filters),
    [findings, state.filters]
  );
  const inSection = useMemo(() => findingsInSection(filtered, section), [filtered, section]);
  const counts = useMemo(() => countBySection(filtered), [filtered]);
  const areas = useMemo(
    () => areaFilterOptions(findings, state.filters, section),
    [findings, state.filters, section]
  );
  // A switch is two moves that have to happen together: the address bar drops
  // to the new audit with nothing of the old view left on it, and the read that
  // fills the console is reissued against it.
  const chooseAudit = useCallback(
    (name: string): void => {
      switchAudit(name);
      onAudit(name);
    },
    [onAudit, switchAudit]
  );

  // One way to another section, shared by the tab that names it and by any pane
  // that sends the reader on: two spellings of the same move would sooner or
  // later leave the reader's history holding one of them and not the other.
  const goToSection = useCallback(
    (next: SectionId): void => {
      update({ section: next, focus: null }, 'push');
    },
    [update]
  );

  const deps = useMemo(
    () => ({ put, go: goToSection, onBulkRunning: setBulkRunning }),
    [put, goToSection]
  );
  const body = paneBody(section.id, deps);
  const lead = paneLead(section.id, deps);
  const list = paneList(section.id, deps);

  // The one move along the queue, whoever asked for it: the keyboard, or the
  // pane's own step buttons. A step replaces what is on screen without anything
  // else reporting it, so it is also the one place that has to say so out loud.
  const stepTo = useCallback(
    (focus: string): void => {
      update({ focus });
      setStepped(stepAnnouncement(inSection, focus));
    },
    [update, inSection]
  );

  // A section that renders its own body has no queue on screen, so there is
  // nothing for a step to move along there.
  const move =
    body === undefined
      ? (direction: 1 | -1): void => {
          // Focus mode always has a finding on screen even with no `focus` in
          // the url; a list with nothing selected has none, and the first step
          // there selects the head of the queue.
          const from =
            mode === 'focus' ? (currentIn(inSection, state.focus)?.id ?? null) : state.focus;
          const target = stepFrom(inSection, from, direction);
          if (target === undefined) return;
          stepTo(target.id);
          setKeyboardSteps((taken) => taken + 1);
        }
      : null;

  useStepFocus(paneRef, keyboardSteps);

  const shellBindings = useConsoleHotkeys({
    onSearch: focusSearch,
    onPalette: () => {
      setPaletteOpen(true);
    },
    onShortcuts: () => {
      setLegendOpen(true);
    },
    onMove: move,
  });

  const arrivalNotice = useArrival(findings, section, state, update);
  useScrollRestore(paneRef, `${state.section}|${mode}`);

  // Stable across a keystroke, or every row would re-render for a prop that did
  // not change. Opening moves the view and the finding in one patch, so it
  // costs one history entry and Back undoes the whole move rather than half.
  const onSee = useCallback(
    (focus: string): void => {
      update({ focus });
    },
    [update]
  );

  const openFinding = useCallback(
    (focus: string): void => {
      update({ focus, mode: 'focus' }, 'push');
    },
    [update]
  );

  return (
    <AuditAddressProvider audit={address}>
      {/* Unsent words belong to the audit they were written about, and every
          box that holds any is below here. */}
      <PromptDraftAudit audit={address}>
        <div
          data-testid={TEST_IDS.consoleShell}
          className="bg-background text-foreground flex h-dvh flex-col overflow-hidden"
        >
          {/* First focusable element, so a keyboard reader reaches the queue
            without walking the header and the filter rail. */}
          <a
            href="#main"
            className="bg-background text-foreground sr-only z-50 rounded-md px-4 py-2 focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
          >
            Skip to content
          </a>
          {/* Mounted from the first render and left empty until there is something
            to say: assistive technology announces a change inside a live region
            it was already watching, and never the content a region arrives with. */}
          <p role="status" aria-label="Queue position" className="sr-only">
            {stepped}
          </p>
          <ConsoleHeader
            auditTitle={snapshot.audit.title}
            auditName={snapshot.name}
            audits={snapshot.audits}
            onAudit={chooseAudit}
            bulkRunning={bulkRunning}
            decided={decidedCount(findings)}
            total={findings.length}
            unreadable={snapshot.validation.length}
            live={live}
            section={state.section}
            counts={counts}
            onSection={goToSection}
            query={state.filters.q}
            onQuery={(q) => {
              setFilters({ q });
            }}
            mode={mode}
            onMode={(next) => {
              update({ mode: next }, 'push');
            }}
            onShortcuts={() => {
              setLegendOpen(true);
            }}
          />
          <ValidationBanner entries={snapshot.validation} />
          <ArrivalNotice message={arrivalNotice} />
          <div className="flex min-h-0 flex-1">
            <FilterRail
              filters={state.filters}
              areas={areas}
              onChange={setFilters}
              onClear={() => {
                setFilters(EMPTY_FILTERS);
              }}
            />
            <main id="main" ref={paneRef} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto">
              <SectionPane
                section={section}
                findings={inSection}
                focus={state.focus}
                onOpen={openFinding}
                // Scrolling to a finding moves where the keyboard aims, and nothing
                // else: no history entry, because Back out of a scroll would undo a
                // move the reader never asked for, and nothing said out loud,
                // because a live region firing on every card scrolled past is noise
                // over the one thing the reader wanted to hear.
                onSee={onSee}
                mode={mode}
                filtering={isFiltering(state.filters)}
                onClearFilters={() => {
                  setFilters(EMPTY_FILTERS);
                }}
                {...(body === undefined ? {} : { renderBody: body })}
                {...(lead === undefined ? {} : { renderLead: lead })}
                {...(list === undefined ? {} : { renderList: list })}
                renderDetail={(finding, active) => (
                  <FindingCard
                    finding={finding}
                    findings={findings}
                    queue={inSection}
                    active={active}
                    sectionState={section.state}
                    put={put}
                    onFocus={(id) => {
                      update({ focus: id });
                    }}
                    onJump={(id) => {
                      // A chip lands the reader in another section, so Back is the
                      // only way they have of getting to the one they left.
                      jumpTo(findings, id, (patch) => {
                        update(patch, 'push');
                      });
                    }}
                    onLand={(landed) => {
                      landTo(landed, update);
                      // An undo moves the reader as surely as a step does, and it
                      // is the one move nobody asked for. Without this the live
                      // region goes on holding wherever the reader was before.
                      setStepped(landAnnouncement(landed.id));
                    }}
                  />
                )}
              />
            </main>
          </div>
          {/* Mounted on the shell rather than on the card: the console opens on
            the list, where no card exists, and the palette is the way in. */}
          <FindingPalette
            open={paletteOpen}
            onClose={() => {
              setPaletteOpen(false);
            }}
            findings={findings}
            onJump={(id) => {
              setPaletteOpen(false);
              jumpTo(findings, id, (patch) => {
                update(patch, 'push');
              });
            }}
          />
          {/* Mounted beside the palette rather than inside the card, because the
            shortcuts it lists are reachable from every section. */}
          <ShortcutLegend
            open={legendOpen}
            onClose={() => {
              setLegendOpen(false);
            }}
            bindings={shellBindings}
          />
          {/* The undo affordance has to outlive the card it belongs to, because
            ruling advances past that card the moment the write is sent. */}
          <Toaster />
          <SourcePeek />
        </div>
      </PromptDraftAudit>
    </AuditAddressProvider>
  );
}
