import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { makeFinding } from '@/test-utils/finding-fixture';
import { FindingRow } from './finding-row';
import type { FindingJson } from '@hushbox/docket';
import type { JSX } from 'react';

const LONG_TITLE = `${'a very long sentence that keeps going '.repeat(20)}end`;

function renderRow(
  finding = makeFinding({ id: 'DB-3' }),
  props: Partial<{ selected: boolean; onSelect: (id: string) => void }> = {}
): void {
  render(
    <ul>
      <FindingRow
        finding={finding}
        selected={props.selected ?? false}
        onSelect={props.onSelect ?? ((): void => {})}
      />
    </ul>
  );
}

describe('FindingRow', () => {
  it('names the finding by id and title', () => {
    renderRow(makeFinding({ id: 'DB-3', title: 'The wallet lock is missing' }));

    expect(screen.getByText('DB-3')).toBeInTheDocument();
    expect(screen.getByText('The wallet lock is missing')).toBeInTheDocument();
  });

  it('renders a title the audit wrote in markdown, rather than showing its source', () => {
    const { container } = render(
      <ul>
        <FindingRow
          finding={makeFinding({
            id: 'DB-3',
            title: 'A bare fetch slips past the rule',
            titleHtml: 'A bare <code>fetch</code> slips past the rule',
          })}
          selected={false}
          onSelect={(): void => {}}
        />
      </ul>
    );

    expect(container.querySelector('code')).toHaveTextContent('fetch');
  });

  it('shows the severity as a word', () => {
    renderRow(makeFinding({ id: 'DB-3', severity: 'critical' }));

    expect(screen.getByText('critical')).toBeInTheDocument();
  });

  it('shows the area verbatim, including the migration placeholder', () => {
    renderRow(makeFinding({ id: 'DB-3', area: 'unknown' }));

    expect(screen.getByText('unknown')).toBeInTheDocument();
  });

  it('keeps a paragraph-length title inside the row', () => {
    renderRow(makeFinding({ id: 'DB-3', title: LONG_TITLE }));

    const title = screen.getByText(LONG_TITLE);

    expect(title.className).toContain('line-clamp-2');
    expect(title.className).toContain('break-words');
  });

  it('carries the whole title so nothing is lost to the clamp', () => {
    renderRow(makeFinding({ id: 'DB-3', title: LONG_TITLE }));

    expect(screen.getByRole('button')).toHaveAccessibleName(expect.stringContaining('end'));
  });

  it('marks the row the reader is on', () => {
    renderRow(makeFinding({ id: 'DB-3' }), { selected: true });

    expect(screen.getByRole('button')).toHaveAttribute('aria-current', 'true');
  });

  it('leaves an unselected row unmarked', () => {
    renderRow(makeFinding({ id: 'DB-3' }));

    expect(screen.getByRole('button')).not.toHaveAttribute('aria-current');
  });

  it('marks the row the reader is on with a cue a hover tint cannot imitate', () => {
    renderRow(makeFinding({ id: 'DB-3' }), { selected: true });

    expect(screen.getByRole('button').className).toContain('border-l-primary');
  });

  it('does not redraw a row whose finding and selection did not change', () => {
    const base = makeFinding({ id: 'DB-3' });
    let reads = 0;
    const counted = {
      ...base,
      get titleHtml(): string {
        reads += 1;
        return base.titleHtml;
      },
    } as FindingJson;
    const onSelect = (): void => {};
    // A fresh element each time, or React would bail on the element identity
    // and the test would pass whether or not the row is memoized.
    const row = (): JSX.Element => (
      <ul>
        <FindingRow finding={counted} selected={false} onSelect={onSelect} />
      </ul>
    );
    const view = render(row());

    view.rerender(row());

    expect(reads).toBe(1);
  });

  it('keeps an unselected row the same width as the row the reader is on', () => {
    renderRow(makeFinding({ id: 'DB-3' }));

    const row = screen.getByRole('button');

    expect(row.className).toContain('border-l-4');
    expect(row.className).toContain('border-l-transparent');
  });

  it('reports the finding when clicked', () => {
    const onSelect = vi.fn();
    renderRow(makeFinding({ id: 'DB-3' }), { onSelect });

    fireEvent.click(screen.getByRole('button'));

    expect(onSelect).toHaveBeenCalledWith('DB-3');
  });

  it('flags a warned finding', () => {
    renderRow(makeFinding({ id: 'DB-3', warning: true }));

    expect(screen.getByText('warning')).toBeInTheDocument();
  });

  it('says nothing about warnings on a finding that carries none', () => {
    renderRow(makeFinding({ id: 'DB-3', warning: false }));

    expect(screen.queryByText('warning')).not.toBeInTheDocument();
  });

  it('names the group a finding belongs to', () => {
    renderRow(makeFinding({ id: 'DB-3', group: 'DB-3 + DB-4' }));

    expect(screen.getByText('DB-3 + DB-4')).toBeInTheDocument();
  });
});
