import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { makeFinding } from '@/test-utils/finding-fixture';
import { QuestionBox } from '@/components/finding/question-box';
import { TEST_IDS } from '@/test-ids';
import { QuestionActions } from './question-actions';
import type { PaneWrites } from '../pane-writes';
import type { FindingJson, Question } from '@hushbox/docket';

function asked(overrides: Partial<Question> & { text: string }): Question {
  return {
    at: '2026-07-30',
    answer: null,
    answered_at: null,
    ...overrides,
  };
}

function writes(overrides: Partial<PaneWrites> = {}): PaneWrites {
  return { run: () => Promise.resolve(true), errorFor: () => null, ...overrides };
}

function questioned(questions: readonly Question[]): FindingJson {
  return makeFinding({ id: 'A-1', questions });
}

/**
 * The size a piece of text actually reads at: the nearest one asked for at or
 * above it, since the size is set on the row and inherited by the prose.
 */
function sizeAbove(node: HTMLElement): string | null {
  for (let at: HTMLElement | null = node; at !== null; at = at.parentElement) {
    const rule = [...at.classList].find((name) => /^text-(?:xs|sm|base|lg|xl)$/u.test(name));
    if (rule !== undefined) return rule;
  }
  return null;
}

describe('QuestionActions', () => {
  it('shows what the finding is waiting on an answer for', () => {
    render(
      <QuestionActions
        finding={questioned([asked({ text: 'check the zone' })])}
        writes={writes()}
      />
    );

    expect(screen.getByText('check the zone')).toBeInTheDocument();
  });

  it('offers no way to answer, because an answer is the agent’s to write', () => {
    render(
      <QuestionActions
        finding={questioned([asked({ text: 'check the zone' })])}
        writes={writes()}
      />
    );

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Answer' })).not.toBeInTheDocument();
  });

  /**
   * The same question is read here and on the finding card, so it has to read
   * the same size in both places: one question at two sizes is wrong whichever
   * of the two sizes is the better one. Both surfaces are rendered and measured
   * against each other rather than against a size written into the test, so
   * either one moving is what fails this — a literal would pin this surface and
   * leave the card free to drift away from it.
   */
  it('reads a question at the size the card reads it at', () => {
    const question = asked({ text: 'check the zone' });
    const pane = render(<QuestionActions finding={questioned([question])} writes={writes()} />);
    const card = render(
      <QuestionBox questions={[question]} focused={null} onAsk={() => {}} onDrafting={() => {}} />
    );

    const inPane = sizeAbove(within(pane.container).getByText('check the zone'));
    const inCard = sizeAbove(within(card.container).getByText('check the zone'));

    // Neither surface asking for a size would make the comparison below agree
    // on nothing, so the measurement has to have found one.
    expect(inCard).not.toBeNull();
    expect(inPane).toBe(inCard);
  });

  it('says an unanswered question is waiting rather than leaving it bare', () => {
    render(
      <QuestionActions finding={questioned([asked({ text: 'which pool?' })])} writes={writes()} />
    );

    expect(screen.getByText('waiting on an agent')).toBeInTheDocument();
  });

  it('withdraws a question by its index', async () => {
    const run = vi.fn(() => Promise.resolve(true));
    const finding = questioned([asked({ text: 'first' }), asked({ text: 'second' })]);
    render(<QuestionActions finding={finding} writes={writes({ run })} />);

    fireEvent.click(screen.getAllByTestId(TEST_IDS.questionWithdraw)[1]!);

    await waitFor(() => {
      expect(run).toHaveBeenCalledWith(finding, 'withdraw', { index: 1 });
    });
  });

  it('shows an answer that already came back', () => {
    render(
      <QuestionActions
        finding={questioned([asked({ text: 'q', answer: 'the pooled endpoint' })])}
        writes={writes()}
      />
    );

    expect(screen.getByText('the pooled endpoint')).toBeInTheDocument();
  });

  it('shows a refusal against this finding', () => {
    render(
      <QuestionActions
        finding={questioned([asked({ text: 'q' })])}
        writes={writes({
          errorFor: (id) => (id === 'A-1' ? 'no unanswered question at index 0' : null),
        })}
      />
    );

    expect(screen.getByTestId(TEST_IDS.paneError)).toHaveTextContent(
      'no unanswered question at index 0'
    );
  });

  it('renders nothing for a finding carrying no questions', () => {
    const { container } = render(
      <QuestionActions finding={makeFinding({ id: 'A-1' })} writes={writes()} />
    );

    expect(container).toBeEmptyDOMElement();
  });
});
