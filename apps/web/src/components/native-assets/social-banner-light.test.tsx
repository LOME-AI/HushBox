import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TEST_ID_BUILDERS } from '@hushbox/shared';
import { installThemeTokens } from '@/test-utils/theme-tokens.js';
import { SocialBannerLight } from './social-banner-light';

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    CipherWall: () => <canvas data-testid="cipher-wall" />,
  };
});

describe('SocialBannerLight', () => {
  // The banner resolves its canvas palette off the cascade and refuses an
  // unresolved token; a bare test document defines none.
  let removeThemeTokens: () => void;

  beforeEach(() => {
    removeThemeTokens = installThemeTokens();
  });

  afterEach(() => {
    removeThemeTokens();
  });

  it('renders the light social banner variant', () => {
    render(<SocialBannerLight />);
    expect(screen.getByTestId(TEST_ID_BUILDERS.socialBanner('light'))).toBeInTheDocument();
  });
});
