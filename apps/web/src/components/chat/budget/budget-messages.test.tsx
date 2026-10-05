import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { useA11yStore } from '@hushbox/ui/accessibility/store';
import { BudgetMessages } from '@/components/chat/budget/budget-messages';
import { NOTICE_SHAPES, type NoticeShape } from '@/lib/chat/notice-shape';
import type { BudgetError } from '@hushbox/shared';

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    className,
  }: {
    children: React.ReactNode;
    to: string;
    className?: string;
  }) => (
    <a href={to} className={className} data-testid="budget-link">
      {children}
    </a>
  ),
}));

const HELD: BudgetError = {
  id: 'funds_held_by_run',
  type: 'error',
  message: 'Held',
  blockClears: 'on_its_own',
};
const TOO_LONG: BudgetError = {
  id: 'prompt_too_long',
  type: 'error',
  message: 'Too long',
  blockClears: 'when_the_user_acts',
};
const CANNOT_START: BudgetError = { id: 'send_cannot_start', type: 'error', message: 'Error' };
const SHORTENED: BudgetError = {
  id: 'answer_may_be_shortened',
  type: 'warning',
  message: 'Warning',
};
const ALLOWANCE: BudgetError = { id: 'free_allowance_pays', type: 'info', message: 'Info' };

function notice(id: BudgetError['id']): HTMLElement {
  return screen.getByTestId(TEST_ID_BUILDERS.budgetMessage(id));
}

function severity(id: BudgetError['id']): string | undefined {
  return notice(id).closest<HTMLElement>('[data-severity]')?.dataset['severity'];
}

function queryNotice(id: BudgetError['id']): HTMLElement | null {
  return screen.queryByTestId(TEST_ID_BUILDERS.budgetMessage(id));
}

afterEach(() => {
  act(() => {
    useA11yStore.setState({ stopAnimations: false });
  });
});

describe('BudgetMessages', () => {
  describe('rendering', () => {
    it('renders nothing when there are no notices', () => {
      render(<BudgetMessages errors={[]} />);
      expect(screen.queryByTestId(TEST_IDS.budgetMessages)).not.toBeInTheDocument();
    });

    it('renders every notice it is given, in order', () => {
      render(<BudgetMessages errors={[CANNOT_START, SHORTENED, ALLOWANCE]} />);

      const ids = [
        ...screen
          .getByTestId(TEST_IDS.budgetMessages)
          .querySelectorAll<HTMLElement>('[data-slot="notice"]'),
      ].map((element) => element.dataset['testid']);
      expect(ids).toEqual([
        TEST_ID_BUILDERS.budgetMessage('send_cannot_start'),
        TEST_ID_BUILDERS.budgetMessage('answer_may_be_shortened'),
        TEST_ID_BUILDERS.budgetMessage('free_allowance_pays'),
      ]);
    });

    it('draws each as the composer notice', () => {
      render(<BudgetMessages errors={[CANNOT_START, SHORTENED, ALLOWANCE]} />);

      for (const id of [
        'send_cannot_start',
        'answer_may_be_shortened',
        'free_allowance_pays',
      ] as const) {
        expect(notice(id)).toHaveAttribute('data-placement', 'composer');
      }
    });

    it('accepts a custom className on the stack', () => {
      render(<BudgetMessages errors={[CANNOT_START]} className="custom-class" />);
      expect(screen.getByTestId(TEST_IDS.budgetMessages)).toHaveClass('custom-class');
    });

    it('keeps no icon test id on any notice', () => {
      render(<BudgetMessages errors={[CANNOT_START, SHORTENED, ALLOWANCE]} />);
      expect(document.querySelector('[data-testid^="budget-message-icon-"]')).toBeNull();
    });
  });

  describe('severity', () => {
    it('marks a block that clears on its own with the hourglass', () => {
      render(<BudgetMessages errors={[HELD]} />);
      expect(severity('funds_held_by_run')).toBe('hourglass');
    });

    it('marks a block the user must act on with the circle', () => {
      render(<BudgetMessages errors={[TOO_LONG]} />);
      expect(severity('prompt_too_long')).toBe('circle');
    });

    it('marks a block that declares no clearing with the circle', () => {
      render(<BudgetMessages errors={[CANNOT_START]} />);
      expect(severity('send_cannot_start')).toBe('circle');
    });

    it('marks a warning with the triangle', () => {
      render(<BudgetMessages errors={[SHORTENED]} />);
      expect(severity('answer_may_be_shortened')).toBe('triangle');
    });

    it('marks an info notice with the info circle', () => {
      render(<BudgetMessages errors={[ALLOWANCE]} />);
      expect(severity('free_allowance_pays')).toBe('info');
    });

    it.each<[string, BudgetError, NoticeShape]>([
      ['a block that clears on its own', HELD, 'hourglass'],
      ['a block the user must act on', TOO_LONG, 'circle'],
      ['a warning', SHORTENED, 'triangle'],
      ['an info notice', ALLOWANCE, 'info'],
    ])('draws %s with the icon of its shape', (_name, error, shape) => {
      render(<BudgetMessages errors={[error]} />);
      const drawn = notice(error.id).querySelector('svg');
      const Expected = NOTICE_SHAPES[shape].icon;
      const { container } = render(<Expected />);

      expect(drawn?.innerHTML).toBe(container.querySelector('svg')?.innerHTML);
    });

    it('takes the error tone for a block', () => {
      render(<BudgetMessages errors={[HELD]} />);
      expect(notice('funds_held_by_run')).toHaveAttribute('data-tone', 'error');
    });

    it('takes the warning tone for a warning', () => {
      render(<BudgetMessages errors={[SHORTENED]} />);
      expect(notice('answer_may_be_shortened')).toHaveAttribute('data-tone', 'warning');
    });

    it('takes the info tone for an info notice', () => {
      render(<BudgetMessages errors={[ALLOWANCE]} />);
      expect(notice('free_allowance_pays')).toHaveAttribute('data-tone', 'info');
    });
  });

  describe('announcements', () => {
    it('announces an error as an alert', () => {
      render(<BudgetMessages errors={[CANNOT_START]} />);
      expect(notice('send_cannot_start')).toHaveAttribute('role', 'alert');
    });

    it('announces a warning as a status', () => {
      render(<BudgetMessages errors={[SHORTENED]} />);
      expect(notice('answer_may_be_shortened')).toHaveAttribute('role', 'status');
    });

    it('announces an info notice as a status', () => {
      render(<BudgetMessages errors={[ALLOWANCE]} />);
      expect(notice('free_allowance_pays')).toHaveAttribute('role', 'status');
    });

    it('keeps the stack a polite live region', () => {
      render(<BudgetMessages errors={[SHORTENED]} />);
      expect(screen.getByTestId(TEST_IDS.budgetMessages)).toHaveAttribute('aria-live', 'polite');
    });
  });

  describe('motion', () => {
    it('animates the stack and each notice by default', () => {
      render(<BudgetMessages errors={[SHORTENED, ALLOWANCE]} />);

      const stack = screen.getByTestId(TEST_IDS.budgetMessages);
      expect(stack.querySelectorAll('[data-animated="true"]')).toHaveLength(3);
      expect(stack.querySelector('[data-animated="false"]')).toBeNull();
    });

    it('animates nothing under reduced motion', () => {
      act(() => {
        useA11yStore.setState({ stopAnimations: true });
      });
      render(<BudgetMessages errors={[SHORTENED, ALLOWANCE]} />);

      const stack = screen.getByTestId(TEST_IDS.budgetMessages);
      expect(stack.querySelector('[data-animated="true"]')).toBeNull();
      expect(stack.querySelectorAll('[data-animated="false"]')).toHaveLength(3);
    });

    it('drops a notice that leaves the list while keeping the others', async () => {
      const { rerender } = render(<BudgetMessages errors={[CANNOT_START, SHORTENED]} />);

      rerender(<BudgetMessages errors={[CANNOT_START]} />);

      expect(notice('send_cannot_start')).toBeInTheDocument();
      await waitFor(() => {
        expect(queryNotice('answer_may_be_shortened')).not.toBeInTheDocument();
      });
    });

    it('removes the stack when the list empties', () => {
      const { rerender } = render(<BudgetMessages errors={[CANNOT_START]} />);

      rerender(<BudgetMessages errors={[]} />);

      expect(screen.queryByTestId(TEST_IDS.budgetMessages)).not.toBeInTheDocument();
    });
  });

  describe('text', () => {
    it('renders the plain message when it has no segments', () => {
      render(<BudgetMessages errors={[{ ...ALLOWANCE, message: 'Plain message' }]} />);

      expect(screen.getByText('Plain message')).toBeInTheDocument();
      expect(screen.queryByTestId('budget-link')).not.toBeInTheDocument();
    });

    it('renders the plain message when its segments are empty', () => {
      render(
        <BudgetMessages errors={[{ ...ALLOWANCE, message: 'Plain message', segments: [] }]} />
      );

      expect(screen.getByText('Plain message')).toBeInTheDocument();
      expect(screen.queryByTestId('budget-link')).not.toBeInTheDocument();
    });

    it('reads its segments back as the message, word for word', () => {
      render(
        <BudgetMessages
          errors={[
            {
              ...ALLOWANCE,
              message: 'Sample info. Sign up for details.',
              segments: [
                { text: 'Sample info. ' },
                { text: 'Sign up', link: '/signup' },
                { text: ' for details.' },
              ],
            },
          ]}
        />
      );

      expect(notice('free_allowance_pays')).toHaveTextContent(
        /^Sample info\. Sign up for details\.$/
      );
    });

    it('holds the last two words of a linked notice on one line', () => {
      render(
        <BudgetMessages
          errors={[
            {
              ...SHORTENED,
              message: 'Sample warning. Top up for longer replies.',
              segments: [
                { text: 'Sample warning. ' },
                { text: 'Top up', link: '/billing' },
                { text: ' for longer replies.' },
              ],
            },
          ]}
        />
      );

      expect(within(notice('answer_may_be_shortened')).getByText('longer replies.')).toHaveClass(
        'whitespace-nowrap'
      );
    });

    it('holds the last two words of a plain notice on one line', () => {
      render(<BudgetMessages errors={[{ ...ALLOWANCE, message: 'A plain sample notice.' }]} />);

      expect(within(notice('free_allowance_pays')).getByText('sample notice.')).toHaveClass(
        'whitespace-nowrap'
      );
    });

    it('leaves a one-word notice as it is', () => {
      render(<BudgetMessages errors={[{ ...CANNOT_START, message: 'Sample.' }]} />);

      expect(notice('send_cannot_start').querySelector('.whitespace-nowrap')).toBeNull();
      expect(notice('send_cannot_start')).toHaveTextContent(/^Sample\.$/);
    });

    it('renders a linked segment as a link to its route', () => {
      render(
        <BudgetMessages
          errors={[
            {
              ...SHORTENED,
              message: 'Sample warning. Top up for details.',
              segments: [
                { text: 'Sample warning. ' },
                { text: 'Top up', link: '/billing' },
                { text: ' for details.' },
              ],
            },
          ]}
        />
      );

      const link = within(notice('answer_may_be_shortened')).getByRole('link', { name: 'Top up' });
      expect(link).toHaveAttribute('href', '/billing');
    });
  });

  describe('dismiss', () => {
    it('offers no dismiss on an error', () => {
      render(<BudgetMessages errors={[CANNOT_START]} />);
      expect(
        screen.queryByTestId(TEST_ID_BUILDERS.budgetDismiss('send_cannot_start'))
      ).not.toBeInTheDocument();
    });

    it('offers a dismiss on a warning', () => {
      render(<BudgetMessages errors={[SHORTENED]} />);
      expect(
        screen.getByTestId(TEST_ID_BUILDERS.budgetDismiss('answer_may_be_shortened'))
      ).toBeInTheDocument();
    });

    it('offers a dismiss on an info notice', () => {
      render(<BudgetMessages errors={[ALLOWANCE]} />);
      expect(
        screen.getByTestId(TEST_ID_BUILDERS.budgetDismiss('free_allowance_pays'))
      ).toBeInTheDocument();
    });

    it('names the dismiss for what it does', () => {
      render(<BudgetMessages errors={[SHORTENED]} />);
      expect(
        screen.getByTestId(TEST_ID_BUILDERS.budgetDismiss('answer_may_be_shortened'))
      ).toHaveAccessibleName('Dismiss notification');
    });

    it('hides a warning when its dismiss is pressed', async () => {
      const user = userEvent.setup();
      render(<BudgetMessages errors={[SHORTENED]} />);

      await user.click(
        screen.getByTestId(TEST_ID_BUILDERS.budgetDismiss('answer_may_be_shortened'))
      );

      await waitFor(() => {
        expect(queryNotice('answer_may_be_shortened')).not.toBeInTheDocument();
      });
    });

    it('hides an info notice when its dismiss is pressed', async () => {
      const user = userEvent.setup();
      render(<BudgetMessages errors={[ALLOWANCE]} />);

      await user.click(screen.getByTestId(TEST_ID_BUILDERS.budgetDismiss('free_allowance_pays')));

      await waitFor(() => {
        expect(queryNotice('free_allowance_pays')).not.toBeInTheDocument();
      });
    });

    it('keeps a dismissed notice hidden while it stays in the list', async () => {
      const user = userEvent.setup();
      const { rerender } = render(<BudgetMessages errors={[SHORTENED]} />);

      await user.click(
        screen.getByTestId(TEST_ID_BUILDERS.budgetDismiss('answer_may_be_shortened'))
      );
      await waitFor(() => {
        expect(queryNotice('answer_may_be_shortened')).not.toBeInTheDocument();
      });
      rerender(<BudgetMessages errors={[SHORTENED, ALLOWANCE]} />);

      expect(notice('free_allowance_pays')).toBeInTheDocument();
      expect(queryNotice('answer_may_be_shortened')).not.toBeInTheDocument();
    });

    it('returns a dismissed notice once it has left the list and come back', async () => {
      const user = userEvent.setup();
      const { rerender } = render(<BudgetMessages errors={[SHORTENED]} />);

      await user.click(
        screen.getByTestId(TEST_ID_BUILDERS.budgetDismiss('answer_may_be_shortened'))
      );
      await waitFor(() => {
        expect(queryNotice('answer_may_be_shortened')).not.toBeInTheDocument();
      });
      rerender(<BudgetMessages errors={[]} />);
      rerender(<BudgetMessages errors={[SHORTENED]} />);

      expect(notice('answer_may_be_shortened')).toBeInTheDocument();
    });

    it('leaves the other notices in place when one is dismissed', async () => {
      const user = userEvent.setup();
      render(<BudgetMessages errors={[CANNOT_START, SHORTENED]} />);

      await user.click(
        screen.getByTestId(TEST_ID_BUILDERS.budgetDismiss('answer_may_be_shortened'))
      );
      await waitFor(() => {
        expect(queryNotice('answer_may_be_shortened')).not.toBeInTheDocument();
      });

      expect(notice('send_cannot_start')).toBeInTheDocument();
    });
  });
});
