import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TEST_ID_BUILDERS } from '@hushbox/shared';
import { MemberAvatar } from '@/components/chat/member/member-avatar';

describe('MemberAvatar', () => {
  const defaultProps = {
    initial: 'A',
    isOnline: false,
    testIdPrefix: 'member',
    entityId: 'm1',
  } as const;

  describe('size', () => {
    it('renders a 24px circle at the small size', () => {
      render(<MemberAvatar {...defaultProps} size="sm" />);
      expect(screen.getByText('A')).toHaveClass('size-6');
    });

    it('renders a 32px circle at the medium size', () => {
      render(<MemberAvatar {...defaultProps} size="md" />);
      expect(screen.getByText('A')).toHaveClass('size-8');
    });

    it('scales the initial down at the small size', () => {
      render(<MemberAvatar {...defaultProps} size="sm" />);
      expect(screen.getByText('A')).toHaveClass('text-xs');
    });

    it('scales the initial up at the medium size', () => {
      render(<MemberAvatar {...defaultProps} size="md" />);
      expect(screen.getByText('A')).toHaveClass('text-sm');
    });
  });

  describe('caller styling', () => {
    it('merges a caller class onto the circle', () => {
      render(<MemberAvatar {...defaultProps} size="sm" className="-ml-2" />);
      expect(screen.getByText('A')).toHaveClass('-ml-2');
    });

    it('puts a caller-supplied test id on the circle', () => {
      render(<MemberAvatar {...defaultProps} size="sm" data-testid="facepile-avatar" />);
      expect(screen.getByTestId('facepile-avatar')).toHaveTextContent('A');
    });
  });

  describe('online dot', () => {
    it('shows the dot for an online member', () => {
      render(<MemberAvatar {...defaultProps} size="md" isOnline />);
      expect(screen.getByTestId(TEST_ID_BUILDERS.onlineFor('member', 'm1'))).toBeInTheDocument();
    });

    it('hides the dot for an offline member', () => {
      render(<MemberAvatar {...defaultProps} size="md" />);
      expect(
        screen.queryByTestId(TEST_ID_BUILDERS.onlineFor('member', 'm1'))
      ).not.toBeInTheDocument();
    });

    it('builds the dot test id from the caller prefix', () => {
      render(<MemberAvatar {...defaultProps} size="sm" testIdPrefix="member-facepile" isOnline />);
      expect(
        screen.getByTestId(TEST_ID_BUILDERS.onlineFor('member-facepile', 'm1'))
      ).toBeInTheDocument();
    });

    it('rings the dot with the surface token so it matches either theme', () => {
      render(<MemberAvatar {...defaultProps} size="md" isOnline />);
      const dot = screen.getByTestId(TEST_ID_BUILDERS.onlineFor('member', 'm1'));
      expect(dot).toHaveClass('ring-background');
      expect(dot).toHaveClass('ring-2');
    });

    it('keeps the dot inside the circle it marks', () => {
      render(<MemberAvatar {...defaultProps} size="sm" className="-ml-2" isOnline />);
      expect(screen.getByText('A')).toContainElement(
        screen.getByTestId(TEST_ID_BUILDERS.onlineFor('member', 'm1'))
      );
    });
  });
});
