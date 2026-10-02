// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';
import { mockLogoImport } from '@/test-utils/mocks.js';
import { IconForeground } from './icon-foreground';

mockLogoImport();

describe('IconForeground', () => {
  it('renders a container with data-testid', () => {
    render(<IconForeground />);
    expect(screen.getByTestId(TEST_IDS.iconForeground)).toBeInTheDocument();
  });

  it('fills the viewport', () => {
    render(<IconForeground />);
    const container = screen.getByTestId(TEST_IDS.iconForeground);
    // Read off the inline declaration: getComputedStyle resolves a relative
    // length to an absolute one, so toHaveStyle cannot assert a viewport unit.
    expect(container.style.width).toBe('100vw');
    expect(container.style.height).toBe('100vh');
  });

  it('has transparent background', () => {
    render(<IconForeground />);
    const container = screen.getByTestId(TEST_IDS.iconForeground);
    expect(container.style.backgroundColor).toBe('transparent');
  });

  it('renders the logo image', () => {
    render(<IconForeground />);
    const img = screen.getByAltText('HushBox Logo');
    expect(img).toBeInTheDocument();
  });

  it('centers the logo image', () => {
    render(<IconForeground />);
    const container = screen.getByTestId(TEST_IDS.iconForeground);
    expect(container).toHaveStyle({
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    });
  });

  it('sizes the logo within 66% safe zone', () => {
    render(<IconForeground />);
    const img = screen.getByAltText('HushBox Logo');
    expect(img).toHaveStyle({ width: '40%', height: '40%' });
  });
});
