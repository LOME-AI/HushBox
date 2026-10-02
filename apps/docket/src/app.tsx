import { useEffect, useState } from 'react';
import { Button } from '@hushbox/ui';
import { AlertTriangle } from '@hushbox/ui/icons';
import { Notice } from '@hushbox/ui/notice';
import { AsyncRegion } from '@hushbox/ui/surface';
import { auditSnapshotUrl } from '@/api/audit-routes';
import { useAuditSnapshot } from '@/hooks/use-audit-snapshot';
import { parseAudit, parseSearchState, searchStateToQuery } from '@/hooks/use-search-state';
import { ConsoleShell } from '@/components/shell/console-shell';
import { TEST_IDS } from '@/test-ids';
import type { Snapshot } from '@/server/audit-service';
import type { SkeletonShape } from '@hushbox/ui/surface';
import type { JSX } from 'react';

const SERVED_LABEL_ID = 'served-audits';

/** Three rows in the shape of the queue the audit fills. */
const LOADING_PLACEHOLDER: readonly SkeletonShape[] = [
  { kind: 'line', width: '100%' },
  { kind: 'line', width: '100%' },
  { kind: 'line', width: '66%' },
];

/**
 * Where a cold start reads one audit. Built through the address writer rather
 * than spelled here, so the key a link hands the console is the same key the
 * console reads the audit back out of.
 */
function auditHref(name: string): string {
  return searchStateToQuery(parseSearchState(''), name);
}

/**
 * The way off a link naming an audit this repository does not hold. Each name
 * is a link rather than a control that swaps the audit in place: the reader
 * arrives at an address that names what they are looking at, so no audit is
 * ever shown under another one's name.
 */
function ServedAudits({ audits }: Readonly<{ audits: readonly string[] }>): JSX.Element {
  return (
    <>
      <p id={SERVED_LABEL_ID} className="text-muted-foreground text-sm">
        Audits in this repository
      </p>
      <nav aria-labelledby={SERVED_LABEL_ID}>
        <ul className="flex flex-wrap gap-2">
          {audits.map((name) => (
            <li key={name}>
              <Button asChild variant="outline" size="sm">
                <a href={auditHref(name)} className="font-mono">
                  {name}
                </a>
              </Button>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}

export function App(): JSX.Element {
  // Which audit is read. It is held above the shell rather than inside it
  // because a change of audit is what replaces the shell: the read has to be
  // reissued while there is nothing on screen to reissue it.
  const [audit, setAudit] = useState<string | null>(() => parseAudit(globalThis.location.search));
  const [served, setServed] = useState<readonly string[]>([]);

  useEffect(() => {
    // Back and forward move between audits the way they move between any other
    // part of the view, and the address bar is what says where they landed.
    const onPopState = (): void => {
      setAudit(parseAudit(globalThis.location.search));
    };
    globalThis.addEventListener('popstate', onPopState);
    return () => {
      globalThis.removeEventListener('popstate', onPopState);
    };
  }, []);

  const state = useAuditSnapshot(audit);
  // A link outlives the directory it names, so the address bar can ask for an
  // audit the server will not serve. The refusal stands and nothing is loaded
  // in its place; the served names are read only so the refusal has a way out.
  const unservable = state.status === 'failed' && audit !== null;

  useEffect(() => {
    if (!unservable) return;
    const controller = new AbortController();

    void (async (): Promise<void> => {
      try {
        const response = await fetch(auditSnapshotUrl(null), { signal: controller.signal });
        if (response.ok) setServed(((await response.json()) as Snapshot).audits);
      } catch {
        // A way out depends on the server saying what it serves. Where it
        // cannot, the refusal already on screen is still the whole truth.
        setServed([]);
      }
    })();

    return () => {
      controller.abort();
    };
  }, [unservable]);

  if (state.status === 'ready')
    return (
      // Keyed by the audit on screen: which dialog the reader had open and
      // where each pane was scrolled to were taken on that audit, and the next
      // one is a different set of findings entirely.
      <ConsoleShell key={state.snapshot.name} snapshot={state.snapshot} onAudit={setAudit} />
    );

  return (
    <div
      data-testid={TEST_IDS.consoleRoot}
      className="bg-background text-foreground flex h-dvh flex-col gap-3 p-4"
    >
      {state.status === 'failed' ? (
        <>
          <Notice tone="error" icon={AlertTriangle} destructive>
            {audit === null ? state.message : `${audit}: ${state.message}`}
          </Notice>
          {served.length > 0 && <ServedAudits audits={served} />}
        </>
      ) : (
        <>
          <p className="text-muted-foreground text-sm">Loading the audit</p>
          <AsyncRegion status="pending" label="The audit" placeholder={LOADING_PLACEHOLDER}>
            {null}
          </AsyncRegion>
        </>
      )}
    </div>
  );
}
