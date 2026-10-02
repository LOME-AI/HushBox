import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { makeFinding } from '@/test-utils/finding-fixture';
import { TEST_IDS } from '@/test-ids';
import { App } from './app';
import type { Snapshot } from '@/server/audit-service';

const AUDITS = ['2026-07-30', '2026-09-01'];

function snapshotOf(name: string, title: string, ids: readonly string[]): Snapshot {
  return {
    audit: {
      layout_version: 1,
      date: name,
      title: title,
      scope: 'The whole repository',
      body: '',
    },
    name: name,
    findings: ids.map((id) => makeFinding({ id })),
    validation: [],
    audits: AUDITS,
  };
}

const DEFAULT_AUDIT = snapshotOf('2026-07-30', 'Codebase audit', ['A-1']);
const OTHER_AUDIT = snapshotOf('2026-09-01', 'Harness audit', ['H-1']);

/**
 * The audit server, answering exactly the routes the console addresses. The
 * console is what decides which of them it asks for, so a test reads which
 * audit reached the screen rather than which url was built.
 */
function serve(served: Readonly<Record<string, Snapshot>>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const snapshot = served[String(input)];
      return Promise.resolve(
        snapshot === undefined ? new Response(null, { status: 404 }) : Response.json(snapshot)
      );
    })
  );
}

const BOTH_AUDITS = {
  '/api/audit': DEFAULT_AUDIT,
  '/api/audits/2026-09-01/audit': OTHER_AUDIT,
};

/** A fetch nobody answers, which is the console waiting on the audit. */
function serveNothing(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => undefined))
  );
}

function auditTitle(): Promise<HTMLElement> {
  return screen.findByRole('heading', { level: 1 });
}

function chooseAudit(name: string): void {
  fireEvent.change(screen.getByTestId(TEST_IDS.auditSwitcher), { target: { value: name } });
}

describe('App', () => {
  beforeEach(() => {
    globalThis.history.replaceState({}, '', '/');
    globalThis.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the audit is on its way', () => {
    serveNothing();

    render(<App />);

    expect(screen.getByTestId(TEST_IDS.consoleRoot)).toHaveTextContent('Loading the audit');
  });

  /**
   * The console's type scale has no step below `text-sm`, and this line is the
   * first thing a reader ever sees. Nothing here reads a computed size; what is
   * reachable is which step the line asks for.
   */
  it('sizes the waiting line to the console’s smallest step', () => {
    serveNothing();

    render(<App />);

    const waiting = screen.getByText('Loading the audit');

    expect(waiting).toHaveClass('text-sm');
    expect(waiting).not.toHaveClass('text-xs');
  });

  it('says why nothing loaded', async () => {
    serve({});

    render(<App />);

    expect(await screen.findByRole('alert')).toHaveTextContent('(404)');
  });

  it('hands the audit to the shell', async () => {
    serve(BOTH_AUDITS);

    render(<App />);

    expect(await auditTitle()).toHaveTextContent('Codebase audit');
    expect(screen.getByTestId(TEST_IDS.consoleShell)).toBeInTheDocument();
  });

  /**
   * The whole point of naming an audit in a link. Every request the console
   * makes is addressed to the audit in the address bar, so the findings it
   * shows have to come from there too — a console reading one audit and
   * writing to another rules on findings the reader never saw.
   */
  it('reads the audit the address bar names rather than the one served by default', async () => {
    serve(BOTH_AUDITS);
    globalThis.history.replaceState({}, '', '/?audit=2026-09-01');

    render(<App />);

    expect(await auditTitle()).toHaveTextContent('Harness audit');
    expect(screen.getByText('H-1')).toBeInTheDocument();
    expect(screen.queryByText('A-1')).toBeNull();
  });

  it('reads the audit the reader chooses', async () => {
    serve(BOTH_AUDITS);
    render(<App />);
    await auditTitle();

    chooseAudit('2026-09-01');

    expect(await auditTitle()).toHaveTextContent('Harness audit');
    expect(screen.getByText('H-1')).toBeInTheDocument();
  });

  it('leaves the chosen audit in the address bar, so the view is still a link', async () => {
    serve(BOTH_AUDITS);
    render(<App />);
    await auditTitle();

    chooseAudit('2026-09-01');
    await auditTitle();

    expect(globalThis.location.search).toBe('?audit=2026-09-01');
  });

  /**
   * Everything the shell holds — which dialog is open, where a pane was
   * scrolled to — was taken on the audit the reader left, and means nothing on
   * the one they arrived at.
   */
  it('carries nothing the reader had open on one audit onto the next', async () => {
    serve(BOTH_AUDITS);
    render(<App />);
    await auditTitle();
    fireEvent.click(screen.getByRole('button', { name: /Keyboard shortcuts/u }));
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();

    chooseAudit('2026-09-01');
    await auditTitle();

    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();
  });

  it('follows the address bar back to the audit the reader came from', async () => {
    serve(BOTH_AUDITS);
    globalThis.history.replaceState({}, '', '/?audit=2026-09-01');
    render(<App />);
    expect(await auditTitle()).toHaveTextContent('Harness audit');

    act(() => {
      globalThis.history.replaceState({}, '', '/');
      globalThis.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(await auditTitle()).toHaveTextContent('Codebase audit');
  });

  /**
   * A link outlives the directory it names, so the audit in the address bar
   * can be one this repository no longer holds. The refusal is a dead end
   * unless it says which audit was asked for and which ones are there.
   */
  describe('an audit the console cannot serve', () => {
    const MISSING = '2026-09-99';

    function openMissingAudit(): void {
      globalThis.history.replaceState({}, '', `/?audit=${MISSING}`);
      render(<App />);
    }

    it('names the audit the link asked for', async () => {
      serve({ '/api/audit': DEFAULT_AUDIT });

      openMissingAudit();

      expect(await screen.findByRole('alert')).toHaveTextContent(
        `${MISSING}: the audit could not be read (404)`
      );
    });

    it('names the audits this repository does hold', async () => {
      serve({ '/api/audit': DEFAULT_AUDIT });

      openMissingAudit();

      expect(await screen.findByRole('link', { name: '2026-07-30' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: '2026-09-01' })).toBeInTheDocument();
    });

    it('leads to a working audit without the reader editing the address bar', async () => {
      serve({ '/api/audit': DEFAULT_AUDIT });

      openMissingAudit();

      expect(await screen.findByRole('link', { name: '2026-09-01' })).toHaveAttribute(
        'href',
        '?audit=2026-09-01'
      );
    });

    /**
     * The one outcome ruled out. A reader who followed a link to one audit and
     * was quietly given another would rule on findings they never asked to see.
     */
    it('puts no other audit’s findings on screen', async () => {
      serve({ '/api/audit': DEFAULT_AUDIT });

      openMissingAudit();
      await screen.findByRole('link', { name: '2026-07-30' });

      expect(screen.queryByText('A-1')).toBeNull();
      expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
      expect(screen.queryByTestId(TEST_IDS.consoleShell)).toBeNull();
    });

    it('offers no way out when the server will not say what it serves', async () => {
      serve({});

      openMissingAudit();

      expect(await screen.findByRole('alert')).toBeInTheDocument();
      expect(screen.queryByRole('link')).toBeNull();
    });

    it('offers no way out when the server cannot be reached at all', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn((input: unknown) =>
          String(input) === '/api/audit'
            ? Promise.reject(new Error('the console is offline'))
            : Promise.resolve(new Response(null, { status: 404 }))
        )
      );

      openMissingAudit();

      expect(await screen.findByRole('alert')).toBeInTheDocument();
      expect(screen.queryByRole('link')).toBeNull();
    });
  });
});
