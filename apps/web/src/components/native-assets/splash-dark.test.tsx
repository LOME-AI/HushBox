import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { mockLogoImport } from '@/test-utils/mocks.js';
import { SplashDark } from './splash-dark';

mockLogoImport();

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    CipherWall: () => <canvas data-testid="cipher-wall" />,
  };
});

describe('SplashDark', () => {
  it('renders the dark splash variant', () => {
    render(<SplashDark />);
    expect(screen.getByTestId('splash-dark')).toBeInTheDocument();
  });
});
