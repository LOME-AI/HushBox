import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TEST_IDS } from '@/test-ids';
import { PromptDraftAudit, PromptDraftScope, PromptForm } from './prompt-form';
import type { PromptFormProps } from './prompt-form';

function renderForm(overrides: Partial<PromptFormProps> = {}): {
  onSubmit: ReturnType<typeof vi.fn>;
  unmount: () => void;
} {
  const onSubmit = vi.fn();
  const { unmount } = render(
    <PromptForm
      title="Reason"
      placeholder="why"
      submitLabel="Deny"
      onSubmit={onSubmit}
      {...overrides}
    />
  );
  return { onSubmit, unmount };
}

function type(text: string): void {
  fireEvent.change(screen.getByTestId(TEST_IDS.promptInput), { target: { value: text } });
}

describe('PromptForm', () => {
  it('names what is being written', () => {
    renderForm();

    expect(screen.getByText('Reason')).toBeInTheDocument();
  });

  /**
   * The field is the console's whole answer to a reader who has words for a
   * finding: nothing is clicked to reach it, so nothing can be missed.
   */
  it('is on screen with nothing clicked to reveal it', () => {
    renderForm();

    expect(screen.getByTestId(TEST_IDS.promptInput)).toBeInTheDocument();
  });

  it('starts at a single line, so a field nobody is using costs one', () => {
    renderForm();

    expect(screen.getByTestId(TEST_IDS.promptInput)).toHaveAttribute('rows', '1');
  });

  it('submits what was typed', () => {
    const { onSubmit } = renderForm();

    type('  the audit misread the code  ');
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));

    expect(onSubmit).toHaveBeenCalledWith('the audit misread the code');
  });

  it('empties itself once the words have been sent', () => {
    renderForm();

    type('the audit misread the code');
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));

    expect(screen.getByTestId(TEST_IDS.promptInput)).toHaveValue('');
  });

  it('refuses to submit an empty box', () => {
    renderForm();

    expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled();
  });

  it('refuses to submit whitespace', () => {
    renderForm();

    type('   ');

    expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled();
  });

  it('throws the words away from the clear action', () => {
    renderForm();

    type('the audit misread the code');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(screen.getByTestId(TEST_IDS.promptInput)).toHaveValue('');
  });

  it('has nothing to clear while the box is empty', () => {
    renderForm();

    expect(screen.getByRole('button', { name: 'Clear' })).toBeDisabled();
  });

  /**
   * Escape reaches the box where a global shortcut cannot, and it is what hands
   * the console's keyboard back: the words are what holds it, so letting go of
   * them is the same act as finishing with the box.
   */
  it('throws the words away on escape, where a global shortcut cannot reach', () => {
    renderForm();

    type('the audit misread the code');
    fireEvent.keyDown(screen.getByTestId(TEST_IDS.promptInput), { key: 'Escape' });

    expect(screen.getByTestId(TEST_IDS.promptInput)).toHaveValue('');
  });

  it('leaves any other keystroke to the box', () => {
    renderForm();

    type('the audit misread the code');
    fireEvent.keyDown(screen.getByTestId(TEST_IDS.promptInput), { key: 'a' });

    expect(screen.getByTestId(TEST_IDS.promptInput)).toHaveValue('the audit misread the code');
  });

  it('offers the secondary way out when one is given', () => {
    const onClick = vi.fn();
    renderForm({ secondary: { label: 'Deny without a reason', onClick } });

    fireEvent.click(screen.getByRole('button', { name: 'Deny without a reason' }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('offers no secondary way out by default', () => {
    renderForm();

    expect(screen.queryByRole('button', { name: 'Deny without a reason' })).toBeNull();
  });
});

describe('PromptForm caret', () => {
  it('leaves the caret alone, because nobody asked for this field', () => {
    renderForm();

    expect(screen.getByTestId(TEST_IDS.promptInput)).not.toHaveFocus();
  });

  it('takes the caret when the console’s keyboard sends the reader here', () => {
    renderForm({ focus: 1 });

    expect(screen.getByTestId(TEST_IDS.promptInput)).toHaveFocus();
  });
});

/**
 * Unsent words are the one thing on the card the console's keyboard must stay
 * out of: a digit pressed over them would rule the finding instead.
 */
describe('PromptForm drafting', () => {
  it('says nothing is being written while the box is empty', () => {
    const onDrafting = vi.fn();
    renderForm({ onDrafting });

    expect(onDrafting).toHaveBeenCalledWith(false);
  });

  it('says words are being written', () => {
    const onDrafting = vi.fn();
    renderForm({ onDrafting });

    type('the audit misread the code');

    expect(onDrafting).toHaveBeenLastCalledWith(true);
  });

  it('says the writing is over once the words are gone', () => {
    const onDrafting = vi.fn();
    renderForm({ onDrafting });

    type('the audit misread the code');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(onDrafting).toHaveBeenLastCalledWith(false);
  });

  it('counts whitespace as nothing written', () => {
    const onDrafting = vi.fn();
    renderForm({ onDrafting });

    type('   ');

    expect(onDrafting).toHaveBeenLastCalledWith(false);
  });

  /**
   * A box can leave the screen still holding words, because the card withholds
   * a field the moment the decision it takes has been taken. The report is what
   * raises the console's keyboard hold, so a box that goes without retracting
   * it strands the hold: every shortcut dead, and nothing on screen holding
   * anything to blame it on.
   */
  it('says the writing is over when the box leaves the screen holding words', () => {
    const onDrafting = vi.fn();
    const { unmount } = renderForm({ onDrafting });

    type('the audit misread the code');
    unmount();

    expect(onDrafting).toHaveBeenLastCalledWith(false);
  });
});

/**
 * The console's only unsaved state. Every way off a finding unmounts the box,
 * and none of them is a decision to throw the words away.
 */
describe('PromptForm drafts', () => {
  const AUDIT = '2026-07-30';
  const OTHER_AUDIT = '2026-09-01';

  function open(finding: string, title = 'Reason', audit = AUDIT): ReturnType<typeof render> {
    return render(
      <PromptDraftAudit audit={audit}>
        <PromptDraftScope finding={finding}>
          <PromptForm title={title} placeholder="why" submitLabel="Deny" onSubmit={vi.fn()} />
        </PromptDraftScope>
      </PromptDraftAudit>
    );
  }

  it('gives back text the reader was carried away from', () => {
    const first = open('D-1');
    type('the audit misread the code');
    first.unmount();

    open('D-1');

    expect(screen.getByTestId(TEST_IDS.promptInput)).toHaveValue('the audit misread the code');
  });

  it('says the box was filled from a draft, rather than leaving the words unexplained', () => {
    const first = open('D-2');
    type('the audit misread the code');
    first.unmount();

    open('D-2');

    expect(screen.getByText('Restored from your unsent draft.')).toBeInTheDocument();
  });

  it('explains nothing on a box the reader arrived at empty', () => {
    open('D-3');

    expect(screen.queryByText('Restored from your unsent draft.')).toBeNull();
  });

  it('never carries the words written on one finding onto another', () => {
    const first = open('D-4');
    type('the audit misread the code');
    first.unmount();

    open('D-5');

    expect(screen.getByTestId(TEST_IDS.promptInput)).toHaveValue('');
  });

  it('never carries a denial reason into a different field on the same finding', () => {
    const first = open('D-6');
    type('the audit misread the code');
    first.unmount();

    open('D-6', 'Ask the audit');

    expect(screen.getByTestId(TEST_IDS.promptInput)).toHaveValue('');
  });

  it('forgets a draft the reader cleared, because that is a decision to discard it', () => {
    const first = open('D-7');
    type('the audit misread the code');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    first.unmount();

    open('D-7');

    expect(screen.getByTestId(TEST_IDS.promptInput)).toHaveValue('');
  });

  it('forgets a draft the reader escaped out of', () => {
    const first = open('D-8');
    type('the audit misread the code');
    fireEvent.keyDown(screen.getByTestId(TEST_IDS.promptInput), { key: 'Escape' });
    first.unmount();

    open('D-8');

    expect(screen.getByTestId(TEST_IDS.promptInput)).toHaveValue('');
  });

  it('forgets a draft that was sent', () => {
    const first = open('D-9');
    type('the audit misread the code');
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    first.unmount();

    open('D-9');

    expect(screen.getByTestId(TEST_IDS.promptInput)).toHaveValue('');
  });

  it('keeps nothing from a box with only whitespace in it', () => {
    const first = open('D-10');
    type('   ');
    first.unmount();

    open('D-10');

    expect(screen.queryByText('Restored from your unsent draft.')).toBeNull();
  });

  it('throws a restored draft away when the reader clears it', () => {
    const written = open('D-13');
    type('the audit misread the code');
    written.unmount();
    const reopened = open('D-13');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    reopened.unmount();

    open('D-13');

    expect(screen.getByTestId(TEST_IDS.promptInput)).toHaveValue('');
  });

  it('leaves the draft on another finding alone when this one is cleared', () => {
    const written = open('D-11');
    type('the audit misread the code');
    written.unmount();
    const other = open('D-12');
    type('a half sentence');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    other.unmount();

    open('D-11');

    expect(screen.getByTestId(TEST_IDS.promptInput)).toHaveValue('the audit misread the code');
  });

  it('keeps a draft per finding, so writing a second one does not destroy the first', () => {
    const written = open('D-14');
    type('half written denial');
    written.unmount();
    const other = open('D-15');
    type('a question, twenty four c');
    other.unmount();

    open('D-14');

    expect(screen.getByTestId(TEST_IDS.promptInput)).toHaveValue('half written denial');
  });

  /**
   * Nothing stops two audits carrying a finding with the same id: prefixes are
   * chosen by whoever writes the audit, so the same one can be reused.
   */
  it('never carries the words written in one audit onto the same id in another', () => {
    const written = open('AC-1');
    type('the audit misread the code');
    written.unmount();

    open('AC-1', 'Reason', OTHER_AUDIT);

    expect(screen.getByTestId(TEST_IDS.promptInput)).toHaveValue('');
  });

  it('holds each audit’s words apart, so both are there to come back to', () => {
    const written = open('AC-2');
    type('the audit misread the code');
    written.unmount();
    const elsewhere = open('AC-2', 'Reason', OTHER_AUDIT);
    type('a different audit, and a different finding under the same name');
    elsewhere.unmount();

    open('AC-2');

    expect(screen.getByTestId(TEST_IDS.promptInput)).toHaveValue('the audit misread the code');
  });

  /**
   * A console with no audit named above the box has no second audit to confuse
   * the words with, and giving them back is the whole point of keeping them.
   */
  it('gives the words back where nothing above the box names an audit', () => {
    const unnamed = (
      <PromptDraftScope finding="AC-3">
        <PromptForm title="Reason" placeholder="why" submitLabel="Deny" onSubmit={vi.fn()} />
      </PromptDraftScope>
    );
    const written = render(unnamed);
    type('the audit misread the code');
    written.unmount();

    render(unnamed);

    expect(screen.getByTestId(TEST_IDS.promptInput)).toHaveValue('the audit misread the code');
  });

  it('keeps nothing when no finding scopes the box, because a draft would have no owner', () => {
    const unscoped = (
      <PromptDraftAudit audit={AUDIT}>
        <PromptForm title="Reason" placeholder="why" submitLabel="Deny" onSubmit={vi.fn()} />
      </PromptDraftAudit>
    );
    const first = render(unscoped);
    type('the audit misread the code');
    first.unmount();

    render(unscoped);

    expect(screen.getByTestId(TEST_IDS.promptInput)).toHaveValue('');
  });
});
