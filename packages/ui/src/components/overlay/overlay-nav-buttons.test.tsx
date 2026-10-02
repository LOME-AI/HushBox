import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

import { HIT_AREA_CLASSES } from '../button/icon-button';
import { CLOSE_BUTTON_CLASS, OverlayNavButtons } from './overlay-nav-buttons';

/** The tokens that draw a hit-area recipe's target, which exist only under a coarse pointer. */
function coarseTargetTokens(recipe: string): string[] {
  return recipe.split(' ').filter((token) => token.startsWith('pointer-coarse:'));
}

/** The utility a token applies, with its variant prefixes dropped. */
function utility(token: string): string {
  return token.slice(token.lastIndexOf(':') + 1);
}

function focusStyling(tokens: readonly string[]): string[] {
  return tokens.filter((token) => {
    const applied = utility(token);
    return applied.startsWith('ring') || applied.startsWith('outline');
  });
}

describe('OverlayNavButtons focus', () => {
  it('the back button leaves the base outline to draw', () => {
    render(<OverlayNavButtons showBackButton onBack={() => {}} closeElement={null} />);

    const tokens = [...screen.getByRole('button', { name: 'Back' }).classList];

    expect(focusStyling(tokens)).toEqual([]);
  });

  it('the close button class leaves the base outline to draw', () => {
    expect(focusStyling(CLOSE_BUTTON_CLASS.split(' '))).toEqual([]);
  });

  it('draws the close button as a 1.75rem box with its icon centred', () => {
    expect(CLOSE_BUTTON_CLASS.split(' ')).toEqual(
      expect.arrayContaining(['size-7', 'inline-flex', 'items-center', 'justify-center'])
    );
  });

  it('draws the close button at 70% opacity', () => {
    expect(CLOSE_BUTTON_CLASS.split(' ')).toContain('opacity-70');
  });

  it('extends the close button to a 2.75rem target on a coarse pointer', () => {
    expect(CLOSE_BUTTON_CLASS.split(' ')).toEqual(
      expect.arrayContaining(coarseTargetTokens(HIT_AREA_CLASSES.extend))
    );
  });

  it('keeps the close button positioned in its corner', () => {
    expect(CLOSE_BUTTON_CLASS.split(' ')).toEqual(
      expect.arrayContaining(['absolute', 'top-5', 'right-3'])
    );
  });

  it('draws the back button as the same box as the close button', () => {
    render(<OverlayNavButtons showBackButton onBack={() => {}} closeElement={null} />);

    expect(screen.getByRole('button', { name: 'Back' })).toHaveClass(
      'size-7',
      'inline-flex',
      'items-center',
      'justify-center'
    );
  });

  it('extends the back button to a 2.75rem target on a coarse pointer', () => {
    render(<OverlayNavButtons showBackButton onBack={() => {}} closeElement={null} />);

    expect(screen.getByRole('button', { name: 'Back' })).toHaveClass(
      ...coarseTargetTokens(HIT_AREA_CLASSES.extend)
    );
  });

  it('keeps the back button positioned in its corner', () => {
    render(<OverlayNavButtons showBackButton onBack={() => {}} closeElement={null} />);

    expect(screen.getByRole('button', { name: 'Back' })).toHaveClass('absolute', 'top-5', 'left-3');
  });
});
