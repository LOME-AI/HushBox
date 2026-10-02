import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TEST_IDS } from '@/test-ids';
import { QuestionBox } from './question-box';
import type { QuestionBoxProps } from './question-box';
import type { Question } from '@hushbox/docket';

function question(overrides: Partial<Question> = {}): Question {
  return {
    at: '2026-07-30',
    text: 'which pool does this run on?',
    answer: null,
    answered_at: null,
    ...overrides,
  };
}

function renderBox(overrides: Partial<QuestionBoxProps> = {}): {
  onAsk: ReturnType<typeof vi.fn>;
  onDrafting: ReturnType<typeof vi.fn>;
} {
  const onAsk = vi.fn();
  const onDrafting = vi.fn();
  render(
    <QuestionBox
      questions={[]}
      focused={null}
      onAsk={onAsk}
      onDrafting={onDrafting}
      {...overrides}
    />
  );
  return { onAsk, onDrafting };
}

describe('QuestionBox', () => {
  it('shows what was asked', () => {
    renderBox({ questions: [question()] });

    expect(screen.getByText('which pool does this run on?')).toBeInTheDocument();
  });

  it('shows the answer that came back', () => {
    renderBox({ questions: [question({ answer: 'the request pool', answered_at: 'x' })] });

    expect(screen.getByText('the request pool')).toBeInTheDocument();
  });

  it('marks a question still waiting', () => {
    renderBox({ questions: [question()] });

    expect(screen.getByText('waiting for an answer')).toBeInTheDocument();
  });

  it('carries the box a question is written in, with nothing clicked to reveal it', () => {
    renderBox();

    expect(screen.getByTestId(TEST_IDS.promptInput)).toBeInTheDocument();
  });

  it('sends the question that was typed', () => {
    const { onAsk } = renderBox();

    fireEvent.change(screen.getByTestId(TEST_IDS.promptInput), {
      target: { value: 'which pool?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ask the agent' }));

    expect(onAsk).toHaveBeenCalledWith('which pool?');
  });

  it('takes the caret when the console’s keyboard sends the reader here', () => {
    renderBox({ focused: 1 });

    expect(screen.getByTestId(TEST_IDS.promptInput)).toHaveFocus();
  });

  it('reports a question nobody has sent yet', () => {
    const { onDrafting } = renderBox();

    fireEvent.change(screen.getByTestId(TEST_IDS.promptInput), {
      target: { value: 'which pool?' },
    });

    expect(onDrafting).toHaveBeenLastCalledWith(true);
  });
});
