import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { makeFinding, makeQuestion } from '@/test-utils/finding-fixture';
import { TEST_IDS } from '@/test-ids';
import { withAuditAddress } from '@/test-utils/audit-address';
import { QuestionsLead } from './questions-lead';
import type { FindingJson } from '@hushbox/docket';

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(() => Promise.resolve()) },
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function questioned(id: string, text = 'a question'): FindingJson {
  return makeFinding({ id, questions: [makeQuestion({ text })] });
}

describe('QuestionsLead', () => {
  it('renders a title the audit wrote in markdown, rather than showing its source', () => {
    const finding = makeFinding({
      id: 'A-1',
      questions: [makeQuestion()],
      title: 'A bare fetch slips past the rule',
      titleHtml: 'A bare <code>fetch</code> slips past the rule',
    });

    const { container } = render(
      <QuestionsLead findings={[finding]} put={vi.fn()} onBulkRunning={vi.fn()} />,
      {
        wrapper: withAuditAddress,
      }
    );

    expect(container.querySelector('code')).toHaveTextContent('fetch');
  });

  it('puts every finding with an open question under its own heading', () => {
    render(<QuestionsLead findings={[questioned('A-1')]} put={vi.fn()} onBulkRunning={vi.fn()} />, {
      wrapper: withAuditAddress,
    });

    expect(screen.getByRole('heading', { name: /Open questions/ })).toBeInTheDocument();
  });

  it('names the finding each question belongs to', () => {
    render(<QuestionsLead findings={[questioned('A-1')]} put={vi.fn()} onBulkRunning={vi.fn()} />, {
      wrapper: withAuditAddress,
    });

    expect(screen.getByRole('heading', { name: /A-1/ })).toBeInTheDocument();
  });

  it('keeps a question reachable, so it can still be withdrawn', () => {
    render(<QuestionsLead findings={[questioned('A-1')]} put={vi.fn()} onBulkRunning={vi.fn()} />, {
      wrapper: withAuditAddress,
    });

    expect(screen.getByTestId(TEST_IDS.questionWithdraw)).toBeInTheDocument();
  });

  it('leaves a finding carrying nothing outstanding out of the list', () => {
    const settled = makeFinding({ id: 'A-2' });

    render(
      <QuestionsLead
        findings={[questioned('A-1'), settled]}
        put={vi.fn()}
        onBulkRunning={vi.fn()}
      />,
      {
        wrapper: withAuditAddress,
      }
    );

    expect(screen.queryByRole('heading', { name: /A-2/ })).not.toBeInTheDocument();
  });

  it('compiles the agent questions into the copyable block', () => {
    render(
      <QuestionsLead
        findings={[questioned('A-1', 'which pool?')]}
        put={vi.fn()}
        onBulkRunning={vi.fn()}
      />,
      {
        wrapper: withAuditAddress,
      }
    );

    expect(screen.getByTestId(TEST_IDS.compiledQuestions).textContent).toContain('which pool?');
  });

  it('offers the bulk actions over the pane', () => {
    render(<QuestionsLead findings={[questioned('A-1')]} put={vi.fn()} onBulkRunning={vi.fn()} />, {
      wrapper: withAuditAddress,
    });

    expect(screen.getByTestId(TEST_IDS.bulkActions)).toBeInTheDocument();
  });

  it('puts the finding the server hands back into the pane when a question is withdrawn', async () => {
    const withdrawn = makeFinding({ id: 'A-1', state: 'open' });
    const put = vi.fn();
    render(
      <QuestionsLead
        findings={[questioned('A-1')]}
        put={put}
        onBulkRunning={vi.fn()}
        api={{
          fetch: (() =>
            Promise.resolve(
              jsonResponse({ finding: withdrawn, undoToken: 't' })
            )) as unknown as typeof globalThis.fetch,
        }}
      />,
      { wrapper: withAuditAddress }
    );

    fireEvent.click(screen.getByTestId(TEST_IDS.questionWithdraw));

    await waitFor(() => {
      expect(put).toHaveBeenCalledWith(withdrawn);
    });
  });
});
