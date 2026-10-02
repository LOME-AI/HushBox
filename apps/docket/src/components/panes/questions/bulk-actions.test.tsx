import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { makeFinding, makeQuestion } from '@/test-utils/finding-fixture';
import { TEST_IDS } from '@/test-ids';
import { BulkActions } from './bulk-actions';
import type { PaneWrites } from '../pane-writes';
import type { FindingJson, RenderedOption } from '@hushbox/docket';

function option(id: string, recommended: boolean): RenderedOption {
  return {
    id,
    label: `Option ${id}`,
    recommended,
    dedicated: false,
    meta: null,
    html: '<p>body</p>',
  };
}

function writes(run: PaneWrites['run'] = () => Promise.resolve(true)): PaneWrites {
  return { run, errorFor: () => null };
}

function questioned(id: string, overrides: Partial<FindingJson> = {}): FindingJson {
  return makeFinding({ id, questions: [makeQuestion()], ...overrides });
}

describe('BulkActions', () => {
  it('offers to deny every finding the filters admit', () => {
    render(
      <BulkActions
        findings={[questioned('A-1'), questioned('A-2')]}
        writes={writes()}
        onBulkRunning={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Deny all 2' })).toBeEnabled();
  });

  it('counts only the findings a recommendation can be approved on', () => {
    const withRecommendation = questioned('A-1', { options: [option('A', true)] });
    const withoutOne = questioned('A-2', { options: [option('A', false)] });

    render(
      <BulkActions
        findings={[withRecommendation, withoutOne]}
        writes={writes()}
        onBulkRunning={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Approve recommended 1' })).toBeEnabled();
  });

  it('holds the approve action when no finding carries a recommendation', () => {
    render(
      <BulkActions findings={[questioned('A-1')]} writes={writes()} onBulkRunning={vi.fn()} />
    );

    expect(screen.getByRole('button', { name: 'Approve recommended 0' })).toBeDisabled();
  });

  it('holds both actions when the filters admit nothing', () => {
    render(<BulkActions findings={[]} writes={writes()} onBulkRunning={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Deny all 0' })).toBeDisabled();
  });

  it('names every id before denying anything', () => {
    render(
      <BulkActions
        findings={[questioned('A-1'), questioned('A-2')]}
        writes={writes()}
        onBulkRunning={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Deny all 2' }));

    expect(screen.getByText('A-1, A-2')).toBeInTheDocument();
  });

  it('writes nothing until the reader confirms', () => {
    const run = vi.fn(() => Promise.resolve(true));
    render(
      <BulkActions findings={[questioned('A-1')]} writes={writes(run)} onBulkRunning={vi.fn()} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Deny all 1' }));

    expect(run).not.toHaveBeenCalled();
  });

  it('denies every named finding once confirmed', async () => {
    const run = vi.fn(() => Promise.resolve(true));
    render(
      <BulkActions
        findings={[questioned('A-1'), questioned('A-2')]}
        writes={writes(run)}
        onBulkRunning={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Deny all 2' }));
    fireEvent.click(screen.getByTestId(TEST_IDS.confirmAccept));

    await waitFor(() => {
      expect(run).toHaveBeenCalledTimes(2);
    });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: 'A-1' }), 'deny', {});
  });

  it('rules each approved finding as its own recommended option', async () => {
    const run = vi.fn(() => Promise.resolve(true));
    const finding = questioned('A-1', { options: [option('B', false), option('C', true)] });
    render(<BulkActions findings={[finding]} writes={writes(run)} onBulkRunning={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Approve recommended 1' }));
    fireEvent.click(screen.getByTestId(TEST_IDS.confirmAccept));

    await waitFor(() => {
      expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: 'A-1' }), 'rule', {
        option: 'C',
      });
    });
  });

  it('acts only on the findings the filters admit, never the whole audit', async () => {
    const run = vi.fn(() => Promise.resolve(true));
    render(
      <BulkActions findings={[questioned('A-2')]} writes={writes(run)} onBulkRunning={vi.fn()} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Deny all 1' }));
    fireEvent.click(screen.getByTestId(TEST_IDS.confirmAccept));

    await waitFor(() => {
      expect(run).toHaveBeenCalledTimes(1);
    });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: 'A-2' }), 'deny', {});
  });

  it('reports how many landed', async () => {
    render(
      <BulkActions
        findings={[questioned('A-1'), questioned('A-2')]}
        writes={writes()}
        onBulkRunning={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Deny all 2' }));
    fireEvent.click(screen.getByTestId(TEST_IDS.confirmAccept));

    await waitFor(() => {
      expect(screen.getByText('Denied 2 of 2')).toBeInTheDocument();
    });
  });

  it('reports the shortfall when a write is refused', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false) as unknown as PaneWrites['run'];
    render(
      <BulkActions
        findings={[questioned('A-1'), questioned('A-2')]}
        writes={writes(run)}
        onBulkRunning={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Deny all 2' }));
    fireEvent.click(screen.getByTestId(TEST_IDS.confirmAccept));

    await waitFor(() => {
      expect(screen.getByText('Denied 1 of 2')).toBeInTheDocument();
    });
  });

  it('backs out without writing', () => {
    const run = vi.fn(() => Promise.resolve(true));
    render(
      <BulkActions findings={[questioned('A-1')]} writes={writes(run)} onBulkRunning={vi.fn()} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Deny all 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(run).not.toHaveBeenCalled();
    expect(screen.queryByTestId(TEST_IDS.confirmAccept)).not.toBeInTheDocument();
  });

  it('leaves an already denied finding out of the deny target set', () => {
    const denied = makeFinding({
      id: 'A-2',
      state: 'denied',
      denial: { by: 'human', reason: null, at: '2026-07-30' },
    });

    render(
      <BulkActions
        findings={[questioned('A-1'), denied]}
        writes={writes()}
        onBulkRunning={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Deny all 1' })).toBeEnabled();
  });
});
