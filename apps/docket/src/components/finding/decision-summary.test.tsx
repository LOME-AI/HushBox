import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { makeFinding, makeQuestion } from '@/test-utils/finding-fixture';
import { TEST_IDS } from '@/test-ids';
import { DecisionSummary } from './decision-summary';
import type { RenderedOption } from '@hushbox/docket';

const optionA: RenderedOption = {
  id: 'A',
  label: 'Apply the proposed behavior as written',
  recommended: false,
  dedicated: false,
  meta: null,
  html: '<p>Do it</p>',
};

describe('DecisionSummary', () => {
  it('says nothing about a finding nobody has decided', () => {
    render(<DecisionSummary finding={makeFinding({ id: 'A-1' })} />);

    expect(screen.queryByTestId(TEST_IDS.decisionSummary)).toBeNull();
  });

  it('names the option a ruling chose, with the words it chose', () => {
    render(
      <DecisionSummary
        finding={makeFinding({
          id: 'A-1',
          state: 'ruled',
          options: [optionA],
          ruling: { option: 'A', text: null, note: null, at: '2026-07-30' },
        })}
      />
    );

    expect(screen.getByTestId(TEST_IDS.decisionSummary)).toHaveTextContent('Ruled');
    expect(screen.getByTestId(TEST_IDS.decisionSummary)).toHaveTextContent(
      'Option A: Apply the proposed behavior as written'
    );
  });

  it('names the option even when the finding carries no such option to read from', () => {
    render(
      <DecisionSummary
        finding={makeFinding({
          id: 'A-1',
          state: 'ruled',
          ruling: { option: 'B', text: null, note: null, at: '2026-07-30' },
        })}
      />
    );

    expect(screen.getByTestId(TEST_IDS.decisionSummary)).toHaveTextContent('Option B');
  });

  it('shows a free-text ruling as what was written, not as an option id', () => {
    render(
      <DecisionSummary
        finding={makeFinding({
          id: 'A-1',
          state: 'ruled',
          ruling: {
            option: 'other',
            text: 'Do the smaller version first',
            at: '2026-07-30',
            note: null,
          },
        })}
      />
    );

    const summary = screen.getByTestId(TEST_IDS.decisionSummary);
    expect(summary).toHaveTextContent('Do the smaller version first');
    expect(summary).not.toHaveTextContent('Option other');
  });

  it('shows the note a ruling carried', () => {
    render(
      <DecisionSummary
        finding={makeFinding({
          id: 'A-1',
          state: 'ruled',
          ruling: { option: 'A', text: null, note: 'log the skipped pass', at: '2026-07-30' },
        })}
      />
    );

    expect(screen.getByTestId(TEST_IDS.decisionSummary)).toHaveTextContent('log the skipped pass');
  });

  it('shows when the decision was taken', () => {
    render(
      <DecisionSummary
        finding={makeFinding({
          id: 'A-1',
          state: 'ruled',
          ruling: { option: 'A', text: null, note: null, at: '2026-07-30' },
        })}
      />
    );

    expect(screen.getByTestId(TEST_IDS.decisionSummary)).toHaveTextContent('2026-07-30');
  });

  it('reports a denial and its reason', () => {
    render(
      <DecisionSummary
        finding={makeFinding({
          id: 'A-1',
          state: 'denied',
          denial: { by: 'human', reason: 'works as intended', at: '2026-07-30' },
        })}
      />
    );

    const summary = screen.getByTestId(TEST_IDS.decisionSummary);
    expect(summary).toHaveTextContent('Denied');
    expect(summary).toHaveTextContent('works as intended');
  });

  it('says outright when a denial recorded no reason', () => {
    render(
      <DecisionSummary
        finding={makeFinding({
          id: 'A-1',
          state: 'denied',
          denial: { by: 'human', reason: null, at: '2026-07-30' },
        })}
      />
    );

    expect(screen.getByTestId(TEST_IDS.decisionSummary)).toHaveTextContent('No reason recorded');
  });

  it('separates a denial the audit itself made from one the reader made', () => {
    render(
      <DecisionSummary
        finding={makeFinding({
          id: 'A-1',
          state: 'denied',
          denial: { by: 'audit', reason: 'refuted', at: '2026-07-30' },
        })}
      />
    );

    expect(screen.getByTestId(TEST_IDS.decisionSummary)).toHaveTextContent('the audit');
  });

  it('names the state of a finding held on a question', () => {
    render(<DecisionSummary finding={makeFinding({ id: 'A-1', questions: [makeQuestion()] })} />);

    expect(screen.getByTestId(TEST_IDS.decisionSummary)).toHaveTextContent('Question open');
  });

  it('names the agent as the one an outstanding question is waiting on', () => {
    render(<DecisionSummary finding={makeFinding({ id: 'A-1', questions: [makeQuestion()] })} />);

    expect(screen.getByTestId(TEST_IDS.decisionSummary)).toHaveTextContent(
      'Waiting on the implementation agent'
    );
  });

  it('leads with the ruling rather than the question on a finding that carries both', () => {
    render(
      <DecisionSummary
        finding={makeFinding({
          id: 'A-1',
          state: 'ruled',
          ruling: { option: 'A', text: null, note: null, at: '2026-07-30' },
          questions: [makeQuestion()],
        })}
      />
    );

    const summary = screen.getByTestId(TEST_IDS.decisionSummary);
    expect(summary).toHaveTextContent('Ruled');
    expect(summary).not.toHaveTextContent('Question open');
  });

  it('still states an outstanding question on a finding that has been ruled', () => {
    render(
      <DecisionSummary
        finding={makeFinding({
          id: 'A-1',
          state: 'ruled',
          ruling: { option: 'A', text: null, note: null, at: '2026-07-30' },
          questions: [makeQuestion({ text: 'has the chain already run?' })],
        })}
      />
    );

    expect(screen.getByTestId(TEST_IDS.decisionSummary)).toHaveTextContent(
      'has the chain already run?'
    );
  });

  it('states the question the finding is held on, where the state is stated', () => {
    render(
      <DecisionSummary
        finding={makeFinding({
          id: 'A-1',
          questions: [makeQuestion({ text: 'was the destructive chain already applied?' })],
        })}
      />
    );

    expect(screen.getByTestId(TEST_IDS.decisionSummary)).toHaveTextContent(
      'was the destructive chain already applied?'
    );
  });

  it('keeps two outstanding questions in the order they were asked', () => {
    render(
      <DecisionSummary
        finding={makeFinding({
          id: 'A-1',
          questions: [
            makeQuestion({ at: '2026-07-29', text: 'asked first' }),
            makeQuestion({ at: '2026-07-30', text: 'asked second' }),
          ],
        })}
      />
    );

    const read = screen.getByTestId(TEST_IDS.decisionSummary).textContent;

    expect(read.indexOf('asked first')).toBeLessThan(read.indexOf('asked second'));
  });

  it('leaves out a question that already came back answered', () => {
    render(
      <DecisionSummary
        finding={makeFinding({
          id: 'A-1',
          questions: [
            makeQuestion({
              at: '2026-07-29',
              text: 'settled already',
              answer: 'yes',
              answered_at: '2026-07-29',
            }),
            makeQuestion({ at: '2026-07-30', text: 'still outstanding' }),
          ],
        })}
      />
    );

    const summary = screen.getByTestId(TEST_IDS.decisionSummary);
    expect(summary).toHaveTextContent('still outstanding');
    expect(summary).not.toHaveTextContent('settled already');
  });

  it('shows when the question that holds the finding was asked', () => {
    render(
      <DecisionSummary
        finding={makeFinding({
          id: 'A-1',
          questions: [
            makeQuestion({
              at: '2026-07-29',
              text: 'first',
              answer: 'answered',
              answered_at: '2026-07-29',
            }),
            makeQuestion({ at: '2026-07-31', text: 'second' }),
          ],
        })}
      />
    );

    expect(screen.getByTestId(TEST_IDS.decisionSummary)).toHaveTextContent('2026-07-31');
  });

  it('says nothing at all about a finding with no decision and no question', () => {
    const { container } = render(<DecisionSummary finding={makeFinding({ id: 'A-1' })} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('reports how many earlier decisions this one replaced', () => {
    render(
      <DecisionSummary
        finding={makeFinding({
          id: 'A-1',
          state: 'ruled',
          ruling: { option: 'A', text: null, note: null, at: '2026-07-30' },
          history: [
            {
              at: '2026-07-29',
              kind: 'denial',
              superseded_at: '2026-07-30',
              reason: null,
              by: 'human',
            },
          ],
        })}
      />
    );

    expect(screen.getByTestId(TEST_IDS.decisionSummary)).toHaveTextContent(
      'Replaces 1 earlier decision'
    );
  });

  it('counts more than one replaced decision', () => {
    render(
      <DecisionSummary
        finding={makeFinding({
          id: 'A-1',
          state: 'ruled',
          ruling: { option: 'A', text: null, note: null, at: '2026-07-30' },
          history: [
            { at: '1', kind: 'denial', superseded_at: '2', reason: null, by: 'human' },
            { at: '2', kind: 'ruling', superseded_at: '3', option: 'A', text: null, note: null },
          ],
        })}
      />
    );

    expect(screen.getByTestId(TEST_IDS.decisionSummary)).toHaveTextContent(
      'Replaces 2 earlier decisions'
    );
  });
});
