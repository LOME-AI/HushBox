import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { mockLogoImport } from '@/test-utils/mocks.js';
import { SplashLight } from './splash-light';

mockLogoImport();

vi.mock('@/hooks/use-cipher-wall', () => ({
  useCipherWall: () => ({ current: null }),
}));

describe('SplashLight', () => {
  it('renders the light splash variant', () => {
    render(<SplashLight />);
    expect(screen.getByTestId('splash-light')).toBeInTheDocument();
  });
});
