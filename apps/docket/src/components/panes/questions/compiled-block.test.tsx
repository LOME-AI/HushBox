import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { makeFinding, makeQuestion } from '@/test-utils/finding-fixture';
import { TEST_IDS } from '@/test-ids';
import { CompiledBlock } from './compiled-block';
import type { FindingJson } from '@hushbox/docket';

function withQuestion(id: string, text: string): FindingJson {
  return makeFinding({ id, questions: [makeQuestion({ text })] });
}

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CompiledBlock', () => {
  it('shows every outstanding question as one block', () => {
    render(<CompiledBlock findings={[withQuestion('A-1', 'which pool?')]} />);

    expect(screen.getByTestId(TEST_IDS.compiledQuestions).textContent).toContain('which pool?');
  });

  it('sections the block by the title of the finding each question is about', () => {
    render(<CompiledBlock findings={[withQuestion('A-1', 'which pool?')]} />);

    expect(screen.getByTestId(TEST_IDS.compiledQuestions).textContent).toContain(
      '## Title for A-1'
    );
  });

  it('prints the command that answers each question', () => {
    render(<CompiledBlock findings={[withQuestion('A-1', 'which pool?')]} />);

    expect(screen.getByTestId(TEST_IDS.compiledQuestions).textContent).toContain(
      'pnpm docket --answer A-1 "<answer>" --index 0'
    );
  });

  it('covers every questioned finding in the one block', () => {
    render(
      <CompiledBlock
        findings={[withQuestion('A-1', 'which pool?'), withQuestion('A-2', 'when?')]}
      />
    );

    const block = screen.getByTestId(TEST_IDS.compiledQuestions).textContent;
    expect(block).toContain('which pool?');
    expect(block).toContain('when?');
  });

  it('says there is nothing to compile yet rather than showing an empty box', () => {
    render(<CompiledBlock findings={[makeFinding({ id: 'A-1' })]} />);

    expect(screen.getByText('No question is waiting on an agent yet')).toBeInTheDocument();
    expect(screen.queryByTestId(TEST_IDS.compiledQuestions)).not.toBeInTheDocument();
  });

  it('leaves the copy button out when there is nothing to copy', () => {
    render(<CompiledBlock findings={[makeFinding({ id: 'A-1' })]} />);

    expect(screen.queryByTestId(TEST_IDS.compiledQuestionsCopy)).not.toBeInTheDocument();
  });

  it('puts the compiled block on the clipboard', async () => {
    render(<CompiledBlock findings={[withQuestion('A-1', 'which pool?')]} />);

    fireEvent.click(screen.getByTestId(TEST_IDS.compiledQuestionsCopy));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining('which pool?'));
    });
  });

  it('reports the copy landed', async () => {
    render(<CompiledBlock findings={[withQuestion('A-1', 'which pool?')]} />);

    fireEvent.click(screen.getByTestId(TEST_IDS.compiledQuestionsCopy));

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.compiledQuestionsCopy)).toHaveTextContent('Copied');
    });
  });

  it('tells the reader to select the text when the clipboard refuses', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    // happy-dom carries no `execCommand`, which is also the selection fallback's
    // own failure case: absent means the copy cannot land.
    Object.defineProperty(document, 'execCommand', {
      value: () => false,
      configurable: true,
    });
    render(<CompiledBlock findings={[withQuestion('A-1', 'which pool?')]} />);

    fireEvent.click(screen.getByTestId(TEST_IDS.compiledQuestionsCopy));

    await waitFor(() => {
      expect(
        screen.getByText('The clipboard refused. Select the block and copy it by hand.')
      ).toBeInTheDocument();
    });
  });

  it('counts the findings the block covers', () => {
    render(
      <CompiledBlock findings={[withQuestion('A-1', 'first'), withQuestion('A-2', 'second')]} />
    );

    expect(screen.getByText('2 findings')).toBeInTheDocument();
  });

  it('counts one finding without pluralising it', () => {
    render(<CompiledBlock findings={[withQuestion('A-1', 'first')]} />);

    expect(screen.getByText('1 finding')).toBeInTheDocument();
  });

  it('leaves an answered question out of the block', () => {
    const finding = makeFinding({
      id: 'A-1',
      questions: [makeQuestion({ text: 'settled', answer: 'yes', answered_at: '2026-07-31' })],
    });

    render(<CompiledBlock findings={[finding]} />);

    expect(screen.queryByTestId(TEST_IDS.compiledQuestions)).not.toBeInTheDocument();
  });
});
