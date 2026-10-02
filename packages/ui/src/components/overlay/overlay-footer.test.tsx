import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BUTTON_GROUP_MARKER, buttonRowClass } from '../button/button-group-classes';
import { OverlayFooter } from './overlay-footer';

describe('OverlayFooter', () => {
  it('lays its buttons out as a button row', () => {
    render(
      <OverlayFooter>
        <button type="button">Cancel</button>
        <button type="button">Save</button>
      </OverlayFooter>
    );

    const row = screen.getByRole('button', { name: 'Cancel' }).parentElement;
    expect(row).toHaveClass(BUTTON_GROUP_MARKER);
    expect(row?.className).toBe(buttonRowClass);
  });

  it('keeps its buttons in markup order', () => {
    render(
      <OverlayFooter>
        <button type="button">Cancel</button>
        <button type="button">Save</button>
      </OverlayFooter>
    );

    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Cancel',
      'Save',
    ]);
  });
});
