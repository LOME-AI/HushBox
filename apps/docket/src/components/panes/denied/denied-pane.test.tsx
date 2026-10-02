import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { makeFinding } from '@/test-utils/finding-fixture';
import { TEST_IDS } from '@/test-ids';
import { withAuditAddress } from '@/test-utils/audit-address';
import { DeniedPane } from './denied-pane';
import type { Denial, FindingJson } from '@hushbox/docket';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function denied(id: string, by: Denial['by'], at: string): FindingJson {
  return makeFinding({ id, state: 'denied', denial: { by, reason: null, at } });
}

/** Two denied findings, so "the marked one" is a choice rather than the only row. */
function renderPane(props: { readonly focus?: string | null } = {}, container?: HTMLElement): void {
  render(
    <DeniedPane
      findings={[denied('D-1', 'audit', '2026-07-30'), denied('D-2', 'audit', '2026-07-31')]}
      put={vi.fn()}
      focus={null}
      {...props}
    />,
    { wrapper: withAuditAddress, ...(container === undefined ? {} : { container }) }
  );
}

describe('DeniedPane', () => {
  describe('keeping the reader in view', () => {
    const PANE_HEIGHT = 100;
    const ROW_PITCH = 1000;

    /**
     * A pane with the offsets a browser would have produced, one row pitch
     * apart, so the offset the pane lands at names which row it moved to.
     * happy-dom reports every box at the origin on its own.
     */
    function paneWithLayout(): HTMLElement {
      const pane = document.createElement('div');
      pane.style.overflowY = 'auto';
      document.body.append(pane);
      Object.defineProperty(pane, 'clientHeight', { value: PANE_HEIGHT, configurable: true });
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: Element
      ): DOMRect {
        if (this === pane) return { top: 0 } as DOMRect;
        const rows = [...pane.querySelectorAll(`[data-testid="${TEST_IDS.deniedRow}"]`)];
        const row = rows.findIndex((candidate) => candidate.contains(this));
        return { top: row === -1 ? 0 : (row + 1) * ROW_PITCH } as DOMRect;
      });
      return pane;
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('scrolls the marked row into view', () => {
      const pane = paneWithLayout();

      renderPane({ focus: 'D-2' }, pane);

      const rows = screen.getAllByTestId(TEST_IDS.deniedRow);
      const marked = rows.findIndex((row) => row.getAttribute('aria-current') === 'true');
      expect(pane.scrollTop).toBe((marked + 1) * ROW_PITCH - PANE_HEIGHT);
    });

    it('scrolls nothing when the url names no finding', () => {
      const pane = paneWithLayout();

      renderPane({}, pane);

      expect(pane.scrollTop).toBe(0);
    });
  });

  it('marks the finding the url names', () => {
    renderPane({ focus: 'D-2' });

    const marked = screen
      .getAllByTestId(TEST_IDS.deniedRow)
      .filter((row) => row.getAttribute('aria-current') === 'true');

    expect(marked).toHaveLength(1);
    expect(marked[0]).toHaveTextContent('D-2');
  });

  it('marks nothing when the url names no finding', () => {
    renderPane();

    expect(
      screen.getAllByTestId(TEST_IDS.deniedRow).filter((r) => r.hasAttribute('aria-current'))
    ).toHaveLength(0);
  });

  it('splits the pane by who refused the finding', () => {
    render(
      <DeniedPane
        findings={[denied('A-1', 'audit', '2026-07-30'), denied('A-2', 'human', '2026-07-31')]}
        put={vi.fn()}
        focus={null}
      />,
      { wrapper: withAuditAddress }
    );

    expect(screen.getAllByTestId(TEST_IDS.deniedGroup)).toHaveLength(2);
    expect(screen.getByRole('heading', { name: /Denied by you/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Refuted by the audit/ })).toBeInTheDocument();
  });

  it('counts each half', () => {
    render(
      <DeniedPane
        findings={[denied('A-1', 'audit', '2026-07-30'), denied('A-2', 'audit', '2026-07-31')]}
        put={vi.fn()}
        focus={null}
      />,
      { wrapper: withAuditAddress }
    );

    expect(screen.getByRole('heading', { name: 'Refuted by the audit 2' })).toBeInTheDocument();
  });

  it('shows only the half that has anything in it', () => {
    render(
      <DeniedPane findings={[denied('A-1', 'audit', '2026-07-30')]} put={vi.fn()} focus={null} />,
      { wrapper: withAuditAddress }
    );

    expect(screen.getAllByTestId(TEST_IDS.deniedGroup)).toHaveLength(1);
  });

  it('reads each half from its most recent denial backwards', () => {
    render(
      <DeniedPane
        findings={[denied('A-1', 'human', '2026-07-30'), denied('A-2', 'human', '2026-07-31')]}
        put={vi.fn()}
        focus={null}
      />,
      { wrapper: withAuditAddress }
    );

    const ids = screen
      .getAllByTestId(TEST_IDS.deniedRow)
      .map((row) => row.querySelector('span')?.textContent);

    expect(ids).toEqual(['A-2', 'A-1']);
  });

  it('puts the resurrected finding the server hands back into the pane', async () => {
    const reopened = makeFinding({ id: 'A-1', state: 'open', needsOptions: true });
    const put = vi.fn();
    render(
      <DeniedPane
        findings={[denied('A-1', 'audit', '2026-07-30')]}
        put={put}
        focus={null}
        api={{
          fetch: (() =>
            Promise.resolve(
              jsonResponse({ finding: reopened, undoToken: 't' })
            )) as unknown as typeof globalThis.fetch,
        }}
      />,
      { wrapper: withAuditAddress }
    );

    fireEvent.click(screen.getByTestId(TEST_IDS.reopenFinding));
    fireEvent.click(screen.getByTestId(TEST_IDS.confirmAccept));

    await waitFor(() => {
      expect(put).toHaveBeenCalledWith(reopened);
    });
  });
});
