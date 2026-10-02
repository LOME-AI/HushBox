import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { makeFinding } from '@/test-utils/finding-fixture';
import { withAuditAddress } from '@/test-utils/audit-address';
import { TEST_IDS } from '@/test-ids';
import { RuledPane } from './ruled-pane';
import type { FindingJson } from '@hushbox/docket';

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function ruled(id: string, at: string): FindingJson {
  return makeFinding({
    id,
    state: 'ruled',
    ruling: { option: 'A', text: null, note: null, at },
  });
}

/** Two ruled findings, so "the marked one" is a choice rather than the only row. */
function renderPane(props: { readonly focus?: string | null } = {}, container?: HTMLElement): void {
  render(
    <RuledPane
      findings={[ruled('R-1', '2026-07-30'), ruled('R-2', '2026-07-31')]}
      put={vi.fn()}
      focus={null}
      {...props}
    />,
    { wrapper: withAuditAddress, ...(container === undefined ? {} : { container }) }
  );
}

describe('RuledPane', () => {
  describe('keeping the reader in view', () => {
    const PANE_HEIGHT = 400;
    const MARKED_ROW_TOP = 600;

    /**
     * A pane the rows can be scrolled inside, with the marked row placed below
     * its fold. Nothing is laid out here, so the rects the console reads are
     * the ones a real pane would report.
     */
    function scrollablePane(): HTMLElement {
      const pane = document.createElement('div');
      pane.style.overflowY = 'auto';
      document.body.append(pane);
      Object.defineProperty(pane, 'clientHeight', { value: PANE_HEIGHT, configurable: true });
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: HTMLElement
      ): DOMRect {
        const marked = this !== pane && this.getAttribute('aria-current') === 'true';
        return { top: marked ? MARKED_ROW_TOP : 0, height: 40 } as DOMRect;
      });
      return pane;
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('scrolls the marked row into view', () => {
      const pane = scrollablePane();

      renderPane({ focus: 'R-2' }, pane);

      expect(pane.scrollTop).toBe(MARKED_ROW_TOP - PANE_HEIGHT);
    });

    it('scrolls nothing when the url names no finding', () => {
      const pane = scrollablePane();

      renderPane({}, pane);

      expect(pane.scrollTop).toBe(0);
    });
  });

  it('marks the finding the url names', () => {
    renderPane({ focus: 'R-2' });

    const marked = screen
      .getAllByTestId(TEST_IDS.ruledRow)
      .filter((row) => row.getAttribute('aria-current') === 'true');

    expect(marked).toHaveLength(1);
    expect(marked[0]).toHaveTextContent('R-2');
  });

  it('marks nothing when the url names no finding', () => {
    renderPane();

    expect(
      screen.getAllByTestId(TEST_IDS.ruledRow).filter((r) => r.hasAttribute('aria-current'))
    ).toHaveLength(0);
  });

  it('reads from the most recent ruling backwards', () => {
    render(
      <RuledPane
        findings={[ruled('A-1', '2026-07-30'), ruled('A-2', '2026-07-31')]}
        put={vi.fn()}
        focus={null}
      />,
      { wrapper: withAuditAddress }
    );

    const ids = screen
      .getAllByTestId(TEST_IDS.ruledRow)
      .map((row) => row.querySelector('span')?.textContent);

    expect(ids).toEqual(['A-2', 'A-1']);
  });

  it('offers the brief over exactly what the pane shows', () => {
    render(<RuledPane findings={[ruled('A-1', '2026-07-30')]} put={vi.fn()} focus={null} />, {
      wrapper: withAuditAddress,
    });

    expect(screen.getByTestId(TEST_IDS.ruledBriefCopy)).toHaveTextContent('Copy brief for 1');
  });

  it('asks the server for the whole filtered set when the brief is taken', async () => {
    const call = vi.fn(() => Promise.resolve(jsonResponse({ text: 'the brief' })));
    render(
      <RuledPane
        findings={[ruled('A-1', '2026-07-30'), ruled('A-2', '2026-07-31')]}
        put={vi.fn()}
        focus={null}
        briefFetch={call as unknown as typeof globalThis.fetch}
      />,
      { wrapper: withAuditAddress }
    );

    fireEvent.click(screen.getByTestId(TEST_IDS.ruledBriefCopy));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('/api/audits/2026-07-30/brief?ids=A-2%2CA-1');
    });
  });

  it('reports the brief reached the clipboard', async () => {
    render(
      <RuledPane
        findings={[ruled('A-1', '2026-07-30')]}
        put={vi.fn()}
        focus={null}
        briefFetch={
          (() => Promise.resolve(jsonResponse({ text: 'x' }))) as unknown as typeof globalThis.fetch
        }
      />,
      { wrapper: withAuditAddress }
    );

    fireEvent.click(screen.getByTestId(TEST_IDS.ruledBriefCopy));

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.ruledBriefCopy)).toHaveTextContent('Copied');
    });
  });

  it('says why the brief did not come back', async () => {
    render(
      <RuledPane
        findings={[ruled('A-1', '2026-07-30')]}
        put={vi.fn()}
        focus={null}
        briefFetch={
          (() =>
            Promise.resolve(
              jsonResponse({ error: { code: 'not-found', message: 'no finding "A-1"' } }, 404)
            )) as unknown as typeof globalThis.fetch
        }
      />,
      { wrapper: withAuditAddress }
    );

    fireEvent.click(screen.getByTestId(TEST_IDS.ruledBriefCopy));

    await waitFor(() => {
      expect(screen.getByText('no finding "A-1"')).toBeInTheDocument();
    });
  });

  it('puts the reopened finding the server hands back into the pane', async () => {
    const reopened = makeFinding({ id: 'A-1', state: 'open' });
    const put = vi.fn();
    render(
      <RuledPane
        findings={[ruled('A-1', '2026-07-30')]}
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

  it('shows every finding the filters admit', () => {
    render(
      <RuledPane
        findings={[ruled('A-1', '2026-07-30'), ruled('A-2', '2026-07-31')]}
        put={vi.fn()}
        focus={null}
      />,
      { wrapper: withAuditAddress }
    );

    expect(screen.getAllByTestId(TEST_IDS.ruledRow)).toHaveLength(2);
  });
});
