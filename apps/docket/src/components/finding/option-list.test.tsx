import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TEST_IDS } from '@/test-ids';
import { OptionList } from './option-list';
import type { OptionListProps } from './option-list';
import type { RenderedOption } from '@hushbox/docket';

function option(overrides: Partial<RenderedOption> = {}): RenderedOption {
  return {
    id: 'A',
    label: 'Apply it',
    recommended: false,
    dedicated: false,
    meta: null,
    html: '',
    ...overrides,
  };
}

function renderList(overrides: Partial<OptionListProps> = {}): {
  onChoose: ReturnType<typeof vi.fn>;
  onNote: ReturnType<typeof vi.fn>;
  onDrafting: ReturnType<typeof vi.fn>;
} {
  const onChoose = vi.fn();
  const onNote = vi.fn();
  const onDrafting = vi.fn();
  render(
    <OptionList
      options={[option()]}
      needsOptions={false}
      noteFocus={null}
      onChoose={onChoose}
      onNote={onNote}
      onDrafting={onDrafting}
      {...overrides}
    />
  );
  return { onChoose, onNote, onDrafting };
}

describe('OptionList', () => {
  it('renders the option the audit minted, prose and all', () => {
    renderList({ options: [option({ html: '<p>close the pool later</p>' })] });

    expect(screen.getByText('A: Apply it')).toBeInTheDocument();
    expect(screen.getByText('close the pool later')).toBeInTheDocument();
  });

  it('renders an option that carries neither meta nor prose', () => {
    renderList();

    expect(screen.getAllByTestId(TEST_IDS.optionChoice)).toHaveLength(1);
  });

  it('numbers the options so a digit picks one', () => {
    renderList({ options: [option(), option({ id: 'B', label: 'Leave it' })] });

    const choices = screen.getAllByTestId(TEST_IDS.optionChoice);
    expect(choices[0]).toHaveTextContent('1');
    expect(choices[1]).toHaveTextContent('2');
    expect(choices[1]).toHaveTextContent('Leave it');
  });

  it('rules with the option the reader picked', () => {
    const { onChoose } = renderList({
      options: [option(), option({ id: 'B', label: 'Leave it' })],
    });

    fireEvent.click(screen.getAllByTestId(TEST_IDS.optionChoice)[1]!);

    expect(onChoose).toHaveBeenCalledWith('B');
  });

  it('marks the option the audit recommends', () => {
    renderList({ options: [option({ recommended: true })] });

    expect(screen.getByText('Recommended')).toBeInTheDocument();
  });

  it('marks the option whose being chosen owes the finding a session', () => {
    renderList({ options: [option({ dedicated: true })] });

    expect(screen.getByText('Dedicated')).toBeInTheDocument();
  });

  it('leaves an ordinary option unmarked', () => {
    renderList();

    expect(screen.queryByText('Dedicated')).not.toBeInTheDocument();
  });

  it('reads both marks on an option that carries both', () => {
    renderList({ options: [option({ recommended: true, dedicated: true })] });

    expect(screen.getByText('Recommended')).toBeInTheDocument();
    expect(screen.getByText('Dedicated')).toBeInTheDocument();
  });

  it('shows the meta line an option carries', () => {
    renderList({ options: [option({ meta: 'effort: medium · risk: seam' })] });

    expect(screen.getByText('effort: medium · risk: seam')).toBeInTheDocument();
  });

  /**
   * The meta line is the cost-against-risk reading, and the audit writes symbols
   * into it as code spans. Placed as text it shows the reader the backticks.
   */
  it('places the meta line as markup, not as its source', () => {
    renderList({
      options: [option({ meta: 'effort: low · risk: <code>settle()</code> charges twice' })],
    });

    expect(screen.getByText('settle()').tagName).toBe('CODE');
  });

  /**
   * Effort and risk are read against the option they qualify, not as a first
   * paragraph of it: a meta line drawn at body weight reads as prose the option
   * opens with.
   */
  it('draws the meta line as metadata rather than as body prose', () => {
    renderList({
      options: [option({ meta: 'effort: low · risk: <code>settle()</code> charges twice' })],
    });

    const meta = screen.getByText('settle()').closest('div');
    expect(meta?.className).toContain('text-sm');
    expect(meta?.className).toContain('text-muted-foreground');
    expect(meta?.className).not.toContain('text-base');
  });

  it('leads with the option the audit recommends', () => {
    renderList({ options: [option(), option({ id: 'B', recommended: true })] });

    const choices = screen.getAllByTestId(TEST_IDS.optionChoice);
    expect(choices[1]).toHaveAttribute('data-recommended', 'true');
    expect(choices[0]).not.toHaveAttribute('data-recommended');
  });

  /**
   * A note is how a ruling says what it wants done, and a reader who never
   * finds the control never writes one. Every option carries its own.
   */
  it('carries a note field on every option, with nothing clicked to reveal it', () => {
    renderList({ options: [option(), option({ id: 'B' })] });

    expect(screen.getAllByTestId(TEST_IDS.optionNote)).toHaveLength(2);
    expect(screen.getAllByTestId(TEST_IDS.promptInput)).toHaveLength(2);
  });

  it('submits the option and the note together', () => {
    const { onNote } = renderList();

    fireEvent.change(screen.getByTestId(TEST_IDS.promptInput), {
      target: { value: 'do it behind the flag' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Rule with note' }));

    expect(onNote).toHaveBeenCalledWith('A', 'do it behind the flag');
  });

  it('sends the note the reader wrote, not another option’s', () => {
    const { onNote } = renderList({ options: [option(), option({ id: 'B' })] });

    fireEvent.change(screen.getAllByTestId(TEST_IDS.promptInput)[1]!, {
      target: { value: 'do it behind the flag' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Rule with note' })[1]!);

    expect(onNote).toHaveBeenCalledWith('B', 'do it behind the flag');
  });

  it('puts the caret on the note the console’s keyboard asked for', () => {
    renderList({ options: [option(), option({ id: 'B' })], noteFocus: { option: 'B', at: 1 } });

    expect(screen.getAllByTestId(TEST_IDS.promptInput)[1]).toHaveFocus();
  });

  it('reports the option whose note is being written', () => {
    const { onDrafting } = renderList({ options: [option(), option({ id: 'B' })] });

    fireEvent.change(screen.getAllByTestId(TEST_IDS.promptInput)[1]!, {
      target: { value: 'do it behind the flag' },
    });

    expect(onDrafting).toHaveBeenLastCalledWith('B', true);
  });

  it('says outright that a finding carries no options', () => {
    renderList({ options: [] });

    expect(screen.getByText('No options were minted for this finding')).toBeInTheDocument();
    expect(screen.queryAllByTestId(TEST_IDS.optionChoice)).toHaveLength(0);
  });

  it('says a finding with no options is queued for option minting', () => {
    renderList({ options: [], needsOptions: true });

    expect(screen.getByText(/queued for option minting/)).toBeInTheDocument();
  });

  it('does not claim option minting is queued when it is not', () => {
    renderList({ options: [] });

    expect(screen.queryByText(/queued for option minting/)).toBeNull();
  });

  it('does not promise options to a finding that has already been decided', () => {
    renderList({ options: [], needsOptions: true, chosen: 'other' });

    expect(screen.queryByText(/queued for option minting/)).toBeNull();
  });

  it('does not promise options to a finding the reader has denied', () => {
    renderList({ options: [], needsOptions: true, denied: true });

    expect(screen.queryByText(/queued for option minting/)).toBeNull();
  });

  it('offers the reader the ruling every card carries', () => {
    renderList({ options: [], needsOptions: true });

    expect(screen.getByText(/Rule it in your own words/)).toBeInTheDocument();
  });

  it('offers no denial, which a denied card withholds', () => {
    renderList({ options: [], needsOptions: true, denied: true });

    expect(screen.queryByText(/deny it/)).toBeNull();
  });

  it('offers no question, which a decided card withholds', () => {
    renderList({ options: [], needsOptions: true, denied: true });

    expect(screen.queryByText(/ask a question/)).toBeNull();
  });

  it('marks the option a ruling chose', () => {
    renderList({ options: [option(), option({ id: 'B', label: 'Leave it' })], chosen: 'B' });

    const chosen = screen.getByText('B: Leave it').closest('button');
    expect(chosen).toHaveAttribute('data-chosen', 'true');
    expect(screen.getByText('Chosen')).toBeInTheDocument();
  });

  it('leaves the options a ruling passed over unmarked', () => {
    renderList({ options: [option(), option({ id: 'B', label: 'Leave it' })], chosen: 'B' });

    expect(screen.getByText('A: Apply it').closest('button')).not.toHaveAttribute('data-chosen');
  });

  it('marks nothing on a finding nobody has ruled', () => {
    renderList({ options: [option()] });

    expect(screen.queryByText('Chosen')).toBeNull();
  });
});
