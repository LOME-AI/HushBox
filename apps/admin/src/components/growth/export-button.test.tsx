import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { WHOLE_READ } from './csv.js';
import { ExportButton } from './export-button.js';
import type { MockInstance } from 'vitest';

interface Row {
  readonly host: string;
  readonly visitors: number;
}

const ROWS: readonly Row[] = [{ host: 'reddit.com', visitors: 96 }];
/** The line the referrers export opens with where its read answered in one page, unnarrowed. */
const PREAMBLE =
  'growth-referrers: the read behind this export answered in one page. No campaign selection narrowed these rows.';

const COLUMNS = [
  { header: 'Host', value: (row: Row) => row.host },
  { header: 'Visitors', value: (row: Row) => row.visitors },
];

let created: Blob | null = null;
let clickSpy: MockInstance<() => void>;

beforeEach(() => {
  created = null;
  // Spied rather than stubbed wholesale: replacing the URL global with a plain
  // object takes the constructor with it, and the typed client builds every
  // request URL through it.
  Object.assign(URL, {
    createObjectURL: () => 'blob:export',
    revokeObjectURL: () => undefined,
  });
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => {
    created = blob as Blob;
    return 'blob:export';
  });
  vi.spyOn(URL, 'revokeObjectURL');
  // The anchor the component builds is never in the document, so the element is
  // read back from the spy's own record of what it was called on.
  clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ExportButton', () => {
  it('offers the export', () => {
    render(
      <ExportButton name="growth-referrers" extent={WHOLE_READ} columns={COLUMNS} rows={ROWS} />
    );
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeInTheDocument();
  });

  it('hands over a comma-separated file when pressed', async () => {
    render(
      <ExportButton name="growth-referrers" extent={WHOLE_READ} columns={COLUMNS} rows={ROWS} />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(created).not.toBeNull();
    expect(await created!.text()).toBe(`${PREAMBLE}\nHost,Visitors\nreddit.com,96`);
  });

  it('names the file after the panel it came from', async () => {
    render(
      <ExportButton name="growth-referrers" extent={WHOLE_READ} columns={COLUMNS} rows={ROWS} />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    const anchor = clickSpy.mock.instances[0] as HTMLAnchorElement | undefined;
    expect(anchor?.download).toBe('growth-referrers.csv');
  });

  it('releases the handle it created', async () => {
    render(
      <ExportButton name="growth-referrers" extent={WHOLE_READ} columns={COLUMNS} rows={ROWS} />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:export');
  });

  it('exports a header-only file when the panel has no rows', async () => {
    render(
      <ExportButton name="growth-referrers" extent={WHOLE_READ} columns={COLUMNS} rows={[]} />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await created!.text()).toBe(`${PREAMBLE}\nHost,Visitors`);
  });
});

describe('ExportButton on a panel the server pages', () => {
  it('hands over a file saying which page it holds', async () => {
    render(
      <ExportButton
        name="growth-events"
        extent={{ page: { index: 2, hasMore: false }, campaigns: null, absentColumns: null }}
        columns={COLUMNS}
        rows={ROWS}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await created!.text()).toBe(
      'growth-events: the rows below are page 3 of what the read behind this export answered; its other pages are not in this file. No campaign selection narrowed these rows.\nHost,Visitors\nreddit.com,96'
    );
  });
});
