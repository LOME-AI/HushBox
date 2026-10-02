import * as React from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, afterEach } from 'vitest';
import { useA11yStore } from '../accessibility/store';
import { TextareaField } from './textarea-field';

const NOTICE = 'Only the first 5,000 characters will be used.';

function tokens(element: Element): string[] {
  return element.className.split(/\s+/);
}

function describedByIds(element: Element): string[] {
  return (element.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
}

function Counted({
  initial,
  max = 5000,
}: Readonly<{ initial: string; max?: number }>): React.JSX.Element {
  const [value, setValue] = React.useState(initial);
  return (
    <TextareaField
      label="What should every model know?"
      value={value}
      onChange={(event) => {
        setValue(event.target.value);
      }}
      count={{ value: value.length, max }}
    />
  );
}

function textarea(): HTMLElement {
  return screen.getByRole('textbox', { name: 'What should every model know?' });
}

function countText(): HTMLElement {
  return screen.getByText(/^\d[\d,]* \/ \d[\d,]*$/);
}

describe('TextareaField', () => {
  afterEach(() => {
    act(() => {
      useA11yStore.getState().reset();
    });
  });

  it('names the textarea by its label', () => {
    render(<TextareaField label="Feedback" />);

    expect(screen.getByRole('textbox', { name: 'Feedback' }).tagName).toBe('TEXTAREA');
  });

  it('puts the label above the textarea', () => {
    render(<TextareaField label="Feedback" />);
    const label = screen.getByText('Feedback');

    expect(label.compareDocumentPosition(screen.getByRole('textbox'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });

  it('sets the label at 0.875rem and weight 500', () => {
    render(<TextareaField label="Feedback" />);

    expect(tokens(screen.getByText('Feedback'))).toEqual(
      expect.arrayContaining(['text-sm', 'font-medium'])
    );
  });

  it('shows its label by default', () => {
    render(<TextareaField label="Feedback" />);

    expect(tokens(screen.getByText('Feedback'))).not.toContain('sr-only');
  });

  it('hides a hidden label visually', () => {
    render(<TextareaField label="Feedback" labelHidden />);

    expect(tokens(screen.getByText('Feedback'))).toContain('sr-only');
  });

  it('names the textarea by a hidden label', () => {
    render(<TextareaField label="Feedback" labelHidden />);

    expect(screen.getByRole('textbox', { name: 'Feedback' }).tagName).toBe('TEXTAREA');
  });

  it('keeps a hidden label as a label element for the textarea', () => {
    render(<TextareaField label="Feedback" labelHidden />);
    const label = screen.getByText('Feedback');

    expect(label.tagName).toBe('LABEL');
    expect(label).toHaveAttribute('for', screen.getByRole('textbox').id);
  });

  it('marks an optional field in its label', () => {
    render(<TextareaField label="Notes" optional />);

    expect(screen.getByRole('textbox', { name: 'Notes (optional)' })).toBeInTheDocument();
  });

  it('describes the textarea by its help line', () => {
    render(<TextareaField label="Notes" help="For example, your work or your tone." />);

    expect(screen.getByRole('textbox')).toHaveAccessibleDescription(
      'For example, your work or your tone.'
    );
  });

  it('puts the help line below the textarea', () => {
    render(<TextareaField label="Notes" help="For example, your work or your tone." />);

    expect(
      screen
        .getByRole('textbox')
        .compareDocumentPosition(screen.getByText('For example, your work or your tone.'))
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('announces its error as an alert', () => {
    render(<TextareaField label="Notes" error="Notes can't be empty." />);

    expect(screen.getByRole('alert')).toHaveTextContent("Notes can't be empty.");
  });

  it('reports invalid while it holds an error', () => {
    render(<TextareaField label="Notes" error="Notes can't be empty." />);

    expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
  });

  it('describes the textarea by its error', () => {
    render(<TextareaField label="Notes" error="Notes can't be empty." />);

    expect(screen.getByRole('textbox')).toHaveAccessibleDescription("Notes can't be empty.");
  });

  it('is not invalid without an error or a count over its limit', () => {
    render(<TextareaField label="Notes" />);

    expect(screen.getByRole('textbox')).not.toHaveAttribute('aria-invalid');
  });

  it('keeps the ids the caller describes it by', () => {
    render(
      <>
        <p id="caller-hint">Markdown works here.</p>
        <TextareaField label="Notes" aria-describedby="caller-hint" help="Keep it short." />
      </>
    );

    expect(describedByIds(screen.getByRole('textbox'))).toContain('caller-hint');
  });

  it('passes native props to the textarea', () => {
    render(<TextareaField label="Notes" id="notes" rows={5} placeholder="What's on your mind?" />);
    const control = screen.getByRole('textbox');

    expect(control).toHaveAttribute('id', 'notes');
    expect(control).toHaveAttribute('rows', '5');
    expect(control).toHaveAttribute('placeholder', "What's on your mind?");
  });

  it('forwards its ref to the textarea', () => {
    const ref = React.createRef<HTMLTextAreaElement>();
    render(<TextareaField label="Notes" ref={ref} />);

    expect(ref.current).toBe(screen.getByRole('textbox'));
  });

  it('draws the textarea on the control border', () => {
    render(<TextareaField label="Notes" />);
    const control = screen.getByRole('textbox');

    expect(tokens(control)).toContain('border-border-control');
    expect(tokens(control)).not.toContain('border-input');
  });

  it('draws the focus outline on the textarea', () => {
    render(<TextareaField label="Notes" />);

    expect(tokens(screen.getByRole('textbox'))).not.toContain('focus-visible:outline-hidden');
  });

  describe('with a count', () => {
    it('shows the count as value over max, in the locale format', () => {
      render(<Counted initial="abc" />);

      expect(countText()).toHaveTextContent('3 / 5,000');
    });

    it('describes the textarea by its count', () => {
      render(<Counted initial="abc" />);

      expect(describedByIds(textarea())).toContain(countText().id);
    });

    it('sets no native length limit', () => {
      render(<Counted initial="abc" />);

      expect(textarea()).not.toHaveAttribute('maxlength');
    });

    it('lets typing run past the limit', async () => {
      const user = userEvent.setup();
      render(<Counted initial="" max={3} />);

      await user.type(textarea(), 'abcdef');

      expect(textarea()).toHaveValue('abcdef');
    });

    it('keeps the count muted at the limit', () => {
      render(<Counted initial={'a'.repeat(5000)} />);

      expect(tokens(countText())).toContain('text-muted-foreground');
      expect(tokens(countText())).not.toContain('text-destructive');
    });

    it('keeps the field valid at the limit', () => {
      render(<Counted initial={'a'.repeat(5000)} />);

      expect(textarea()).not.toHaveAttribute('aria-invalid');
    });

    it('shows no notice at the limit', () => {
      render(<Counted initial={'a'.repeat(5000)} />);

      expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
    });

    it('turns the count destructive over the limit', () => {
      render(<Counted initial={'a'.repeat(5001)} />);

      expect(tokens(countText())).toContain('text-destructive');
      expect(tokens(countText())).not.toContain('text-muted-foreground');
    });

    it('reports invalid over the limit', () => {
      render(<Counted initial={'a'.repeat(5001)} />);

      expect(textarea()).toHaveAttribute('aria-invalid', 'true');
    });

    it('puts the over-limit notice in a polite live region', () => {
      render(<Counted initial={'a'.repeat(5001)} />);

      expect(screen.getByText(NOTICE).closest('[aria-live]')).toHaveAttribute(
        'aria-live',
        'polite'
      );
    });

    it('holds the live region before the notice enters it', () => {
      render(<Counted initial="abc" />);

      expect(countText().parentElement?.querySelector('[aria-live="polite"]')).not.toBeNull();
    });

    it('shows the notice once typing crosses the limit', async () => {
      const user = userEvent.setup();
      render(<Counted initial="" max={3} />);

      await user.type(textarea(), 'abcd');

      expect(screen.getByText('Only the first 3 characters will be used.')).toBeInTheDocument();
    });

    it('describes the textarea by the notice while over the limit', () => {
      render(<Counted initial={'a'.repeat(5001)} />);

      expect(textarea()).toHaveAccessibleDescription(expect.stringContaining(NOTICE));
    });

    it('brings the notice in without motion under reduced motion', async () => {
      act(() => {
        useA11yStore.getState().update({ stopAnimations: true });
      });
      const user = userEvent.setup();
      render(<Counted initial="" max={3} />);

      await user.type(textarea(), 'abcd');

      expect(
        screen.getByText('Only the first 3 characters will be used.').closest('[data-animated]')
      ).toHaveAttribute('data-animated', 'false');
    });

    it('brings the notice in with motion otherwise', async () => {
      const user = userEvent.setup();
      render(<Counted initial="" max={3} />);

      await user.type(textarea(), 'abcd');

      expect(
        screen.getByText('Only the first 3 characters will be used.').closest('[data-animated]')
      ).toHaveAttribute('data-animated', 'true');
    });
  });
});
