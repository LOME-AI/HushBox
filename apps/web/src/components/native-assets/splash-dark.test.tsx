import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { mockLogoImport } from '@/test-utils/mocks.js';
import { SplashDark } from './splash-dark';

mockLogoImport();

vi.mock('@/hooks/use-cipher-wall', () => ({
  useCipherWall: () => ({ current: null }),
}));

describe('SplashDark', () => {
  it('renders the dark splash variant', () => {
    render(<SplashDark />);
    expect(screen.getByTestId('splash-dark')).toBeInTheDocument();
  });
});
