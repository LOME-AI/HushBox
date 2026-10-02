import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { makeFinding } from '@/test-utils/finding-fixture';
import { TEST_IDS } from '@/test-ids';
import { withAuditAddress } from '@/test-utils/audit-address';
import { ProgressBoard } from './progress-board';
import type { FindingJson, ProgressStatus } from '@hushbox/docket';

function tracked(
  id: string,
  status: ProgressStatus,
  notes: FindingJson['progress']['notes'] = []
): FindingJson {
  return makeFinding({
    id,
    state: 'ruled',
    progress: { status, updated: null, verified: false, notes },
  });
}

function renderBoard(
  findings: readonly FindingJson[],
  call: () => Promise<Response> = () => Promise.resolve(Response.json({}, { status: 200 }))
): {
  put: ReturnType<typeof vi.fn>;
  fetchMock: ReturnType<typeof vi.fn>;
} {
  const put = vi.fn();
  const fetchMock = vi.fn().mockImplementation(call);
  render(<ProgressBoard findings={findings} put={put} api={{ fetch: fetchMock }} />, {
    wrapper: withAuditAddress,
  });
  return { put, fetchMock };
}

describe('ProgressBoard', () => {
  it('reads blocked work first', () => {
    renderBoard([tracked('A-1', 'done'), tracked('A-2', 'blocked')]);

    const columns = screen.getAllByTestId(TEST_IDS.progressColumn);

    expect(columns[0]).toHaveTextContent('Blocked');
  });

  it('gives every status its own column, empty or not', () => {
    renderBoard([]);

    expect(screen.getAllByTestId(TEST_IDS.progressColumn)).toHaveLength(4);
  });

  it('puts each finding under the status it carries', () => {
    renderBoard([tracked('A-1', 'done'), tracked('A-2', 'blocked')]);

    const blocked = screen.getAllByTestId(TEST_IDS.progressColumn)[0]!;

    expect(within(blocked).getByTestId(TEST_IDS.progressCard)).toHaveTextContent('A-2');
  });

  it('says how much work is in each column', () => {
    renderBoard([tracked('A-1', 'blocked'), tracked('A-2', 'blocked')]);

    expect(screen.getAllByTestId(TEST_IDS.progressColumn)[0]).toHaveTextContent('2');
  });

  it('shows a blocked item its latest note without the reader opening anything', () => {
    renderBoard([
      tracked('A-1', 'blocked', [
        { at: '2026-07-30', by: 'agent', text: 'started' },
        { at: '2026-07-31', by: 'agent', text: 'waiting on the schema change' },
      ]),
    ]);

    expect(screen.getAllByTestId(TEST_IDS.progressNote).at(-1)).toHaveTextContent(
      'waiting on the schema change'
    );
  });

  it('writes a status the reader sets on a card', async () => {
    const written = tracked('A-1', 'in-progress');
    const { put, fetchMock } = renderBoard([tracked('A-1', 'not-started')], () =>
      Promise.resolve(Response.json({ finding: written, undoToken: 't' }, { status: 200 }))
    );

    fireEvent.change(screen.getByTestId(TEST_IDS.progressStatus), {
      target: { value: 'in-progress' },
    });

    await waitFor(() => {
      expect(put).toHaveBeenCalledWith(written);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/audits/2026-07-30/finding/A-1/progress',
      expect.objectContaining({ body: JSON.stringify({ status: 'in-progress', base: 'hash' }) })
    );
  });

  it('says on the card when a write is refused', async () => {
    renderBoard([tracked('A-1', 'not-started')], () =>
      Promise.resolve(
        Response.json({ error: { code: 'conflict', message: 'held by a writer' } }, { status: 409 })
      )
    );

    fireEvent.change(screen.getByTestId(TEST_IDS.progressStatus), { target: { value: 'blocked' } });

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.progressError)).toHaveTextContent('held by a writer');
    });
  });
});
