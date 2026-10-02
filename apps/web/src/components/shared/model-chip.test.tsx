import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';
import { ModelChip } from './model-chip';

describe('ModelChip', () => {
  const onClick = (): void => {};

  it('puts the id and test id its caller gives on the button', () => {
    render(
      <ModelChip
        swatch={2}
        label="GPT-5"
        expanded={false}
        onClick={onClick}
        id="model-selector-button"
        data-testid={TEST_IDS.modelSelectorButton}
      />
    );

    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('id', 'model-selector-button');
    expect(button).toHaveAttribute('data-testid', TEST_IDS.modelSelectorButton);
  });

  it('is named by the model it shows', () => {
    render(<ModelChip swatch={2} label="GPT-5" expanded={false} onClick={onClick} />);

    expect(screen.getByRole('button', { name: 'Model: GPT-5' })).toBeInTheDocument();
  });

  it('opens a dialog', () => {
    render(<ModelChip swatch={2} label="GPT-5" expanded={false} onClick={onClick} />);

    expect(screen.getByRole('button')).toHaveAttribute('aria-haspopup', 'dialog');
  });

  it('reports whether its picker is open', () => {
    render(<ModelChip swatch={2} label="GPT-5" expanded onClick={onClick} />);

    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
  });

  it('reports a closed picker', () => {
    render(<ModelChip swatch={2} label="GPT-5" expanded={false} onClick={onClick} />);

    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  });

  it('truncates its label at 18ch', () => {
    render(
      <ModelChip swatch={2} label="Claude Sonnet 4.5 Thinking" expanded={false} onClick={onClick} />
    );

    expect(screen.getByText('Claude Sonnet 4.5 Thinking')).toHaveClass(
      'max-w-[18ch]',
      'min-w-0',
      'truncate'
    );
  });

  it('keeps its swatch', () => {
    render(<ModelChip swatch={3} label="Gemini" expanded={false} onClick={onClick} />);

    expect(screen.getByRole('button').querySelector('[data-slot="swatch"]')).toHaveClass(
      'bg-model-3'
    );
  });

  it('ends on a chevron', () => {
    render(<ModelChip swatch={3} label="Gemini" expanded={false} onClick={onClick} />);

    expect(screen.getByRole('button').lastElementChild?.tagName.toLowerCase()).toBe('svg');
  });

  it('shrinks to its swatch and chevron before its neighbours do', () => {
    render(<ModelChip swatch={3} label="Gemini" expanded={false} onClick={onClick} />);

    const button = screen.getByRole('button');
    expect(button).toHaveClass('shrink', 'min-w-14');
    expect(button).not.toHaveClass('shrink-0');
  });

  it('shows its short label only when the composer is compact', () => {
    render(
      <ModelChip
        swatch={3}
        label="Gemini 2.5 Flash"
        shortLabel="Flash"
        expanded={false}
        onClick={onClick}
      />
    );

    expect(screen.getByText('Flash')).toHaveClass(
      'hidden',
      '@max-composer-compact/composer:inline'
    );
  });

  it('hides its long label when the composer is compact and a short one exists', () => {
    render(
      <ModelChip
        swatch={3}
        label="Gemini 2.5 Flash"
        shortLabel="Flash"
        expanded={false}
        onClick={onClick}
      />
    );

    expect(screen.getByText('Gemini 2.5 Flash')).toHaveClass(
      '@max-composer-compact/composer:hidden'
    );
  });

  it('keeps its one label at every width when it has no short label', () => {
    render(<ModelChip swatch={3} label="Gemini" expanded={false} onClick={onClick} />);

    expect(screen.getByText('Gemini')).not.toHaveClass('@max-composer-compact/composer:hidden');
  });

  it('shows the count of further models beside the name', () => {
    render(
      <ModelChip
        swatch={1}
        label="Claude Sonnet 4.5"
        count=" + 2"
        expanded={false}
        onClick={onClick}
      />
    );

    expect(screen.getByRole('button')).toHaveTextContent('Claude Sonnet 4.5 + 2');
  });

  it('never truncates the count, whatever the name does', () => {
    render(
      <ModelChip
        swatch={1}
        label="Qwen3 Coder 30B A3B Instruct"
        count=" + 2"
        expanded={false}
        onClick={onClick}
      />
    );

    const count = screen.getByText('+ 2');
    expect(count).toHaveClass('shrink-0', 'whitespace-pre');
    expect(count).not.toHaveClass('truncate');
  });

  it('keeps the count in its name for assistive tech', () => {
    render(
      <ModelChip
        swatch={1}
        label="Claude Sonnet 4.5"
        count=" + 2"
        expanded={false}
        onClick={onClick}
      />
    );

    expect(
      screen.getByRole('button', { name: 'Model: Claude Sonnet 4.5 + 2' })
    ).toBeInTheDocument();
  });

  it('draws no count part for one model', () => {
    render(<ModelChip swatch={1} label="Gemini" expanded={false} onClick={onClick} />);

    expect(screen.getByRole('button').querySelector('[data-slot="model-count"]')).toBeNull();
  });

  it('shows the pointer cursor', () => {
    render(<ModelChip swatch={3} label="Gemini" expanded={false} onClick={onClick} />);

    expect(screen.getByRole('button')).toHaveClass('cursor-pointer');
  });

  it('opens its picker on a click', async () => {
    const onOpen = vi.fn();
    render(<ModelChip swatch={3} label="Gemini" expanded={false} onClick={onOpen} />);

    await userEvent.click(screen.getByRole('button'));

    expect(onOpen).toHaveBeenCalledOnce();
  });
});
