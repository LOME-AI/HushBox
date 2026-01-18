import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StableContent } from './stable-content';

describe('StableContent', () => {
  describe('when not stable', () => {
    it('renders skeleton when provided', () => {
      render(
        <StableContent isStable={false} skeleton={<div data-testid="skeleton">Loading...</div>}>
          <div data-testid="content">Content</div>
        </StableContent>
      );

      expect(screen.getByTestId('skeleton')).toBeInTheDocument();
      expect(screen.queryByTestId('content')).not.toBeInTheDocument();
    });

    it('renders invisible children when preserveLayout is true', () => {
      render(
        <StableContent isStable={false} preserveLayout>
          <div data-testid="content">Content</div>
        </StableContent>
      );

      const content = screen.getByTestId('content');
      expect(content).toBeInTheDocument();
      // Check that the wrapper has visibility: hidden
      const wrapper = content.parentElement;
      expect(wrapper).toHaveClass('invisible');
    });

    it('renders nothing when no skeleton and preserveLayout is false', () => {
      const { container } = render(
        <StableContent isStable={false}>
          <div data-testid="content">Content</div>
        </StableContent>
      );

      expect(screen.queryByTestId('content')).not.toBeInTheDocument();
      expect(container.firstChild).toBeNull();
    });

    it('prefers skeleton over preserveLayout when both provided', () => {
      render(
        <StableContent
          isStable={false}
          skeleton={<div data-testid="skeleton">Loading...</div>}
          preserveLayout
        >
          <div data-testid="content">Content</div>
        </StableContent>
      );

      expect(screen.getByTestId('skeleton')).toBeInTheDocument();
      expect(screen.queryByTestId('content')).not.toBeInTheDocument();
    });
  });

  describe('when stable', () => {
    it('renders children directly', () => {
      render(
        <StableContent isStable={true}>
          <div data-testid="content">Content</div>
        </StableContent>
      );

      expect(screen.getByTestId('content')).toBeInTheDocument();
    });

    it('does not render skeleton when stable', () => {
      render(
        <StableContent isStable={true} skeleton={<div data-testid="skeleton">Loading...</div>}>
          <div data-testid="content">Content</div>
        </StableContent>
      );

      expect(screen.getByTestId('content')).toBeInTheDocument();
      expect(screen.queryByTestId('skeleton')).not.toBeInTheDocument();
    });

    it('renders children without invisible wrapper when stable', () => {
      render(
        <StableContent isStable={true} preserveLayout>
          <div data-testid="content">Content</div>
        </StableContent>
      );

      const content = screen.getByTestId('content');
      expect(content).toBeInTheDocument();
      // Wrapper should not have invisible class
      expect(content.parentElement).not.toHaveClass('invisible');
    });
  });

  describe('props', () => {
    it('passes through className to wrapper', () => {
      render(
        <StableContent isStable={false} preserveLayout className="custom-class">
          <div data-testid="content">Content</div>
        </StableContent>
      );

      const content = screen.getByTestId('content');
      const wrapper = content.parentElement;
      expect(wrapper).toHaveClass('custom-class');
    });

    it('passes through data-testid', () => {
      render(
        <StableContent isStable={true} data-testid="stable-wrapper">
          <div>Content</div>
        </StableContent>
      );

      expect(screen.getByTestId('stable-wrapper')).toBeInTheDocument();
    });
  });
});
