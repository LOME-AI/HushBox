import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';
import { AccessibilityPreview } from './accessibility-preview';

const REPLY =
  'Sourdough at 75% hydration means 750 g of water for every kilogram of flour. Start at 70% if the dough feels hard to shape, and read the hydration guide for the full method.';

function preview(): HTMLElement {
  return screen.getByTestId(TEST_IDS.accessibilityPreview);
}

describe('AccessibilityPreview', () => {
  it('is a region named Preview', () => {
    render(<AccessibilityPreview />);

    expect(screen.getByRole('region', { name: 'Preview' })).toBe(preview());
  });

  it('names the model that wrote the reply', () => {
    render(<AccessibilityPreview />);

    expect(within(preview()).getByTestId(TEST_IDS.modelNametag)).toHaveTextContent(
      'Claude Sonnet 4.5'
    );
  });

  it('names the model maker', () => {
    render(<AccessibilityPreview />);

    expect(within(preview()).getByText('Anthropic')).toBeInTheDocument();
  });

  it('marks the reply with the first model swatch', () => {
    render(<AccessibilityPreview />);

    expect(preview().querySelector('[data-slot="swatch"]')).toHaveClass('bg-model-1');
  });

  it('shows the sample reply in the reading face', () => {
    render(<AccessibilityPreview />);

    const reply = within(preview()).getByText(
      (_, element) => element?.tagName === 'P' && element.textContent === REPLY
    );
    expect(reply).toHaveAttribute('data-reading');
  });

  it('draws the reply link in the brand red', () => {
    render(<AccessibilityPreview />);

    expect(within(preview()).getByRole('link', { name: 'hydration guide' })).toHaveClass(
      'text-brand-red'
    );
  });

  it('holds 900 g in the Loaf weight field', () => {
    render(<AccessibilityPreview />);

    expect(within(preview()).getByLabelText('Loaf weight')).toHaveValue('900 g');
  });

  it('offers Cancel and Save recipe as plain buttons', () => {
    render(<AccessibilityPreview />);

    const names = within(preview())
      .getAllByRole('button')
      .map((button) => [button.textContent, button.getAttribute('type')]);
    expect(names).toEqual([
      ['Cancel', 'button'],
      ['Save recipe', 'button'],
    ]);
  });

  it('draws Save recipe as the primary button', () => {
    render(<AccessibilityPreview />);

    expect(within(preview()).getByRole('button', { name: 'Save recipe' })).toHaveAttribute(
      'data-variant',
      'default'
    );
  });

  it('keeps the link from navigating', async () => {
    const user = userEvent.setup();
    render(<AccessibilityPreview />);
    const before = globalThis.location.href;

    await user.click(within(preview()).getByRole('link', { name: 'hydration guide' }));

    expect(globalThis.location.href).toBe(before);
  });

  it('keeps the field value when typed into', async () => {
    const user = userEvent.setup();
    render(<AccessibilityPreview />);
    const field = within(preview()).getByLabelText('Loaf weight');

    await user.type(field, '50');

    expect(field).toHaveValue('900 g');
  });

  it('takes focus on each control in reading order', async () => {
    const user = userEvent.setup();
    render(<AccessibilityPreview />);
    const region = within(preview());
    const expected = [
      region.getByRole('link', { name: 'hydration guide' }),
      region.getByLabelText('Loaf weight'),
      region.getByRole('button', { name: 'Cancel' }),
      region.getByRole('button', { name: 'Save recipe' }),
    ];

    for (const control of expected) {
      await user.tab();
      expect(document.activeElement).toBe(control);
    }
  });

  it('hides the field and buttons below 768', () => {
    render(<AccessibilityPreview />);

    const field = within(preview()).getByLabelText('Loaf weight');
    expect(field.closest('[data-preview-form]')).toHaveClass('max-md:hidden');
  });

  it('clamps the reply to three lines below 768', () => {
    render(<AccessibilityPreview />);

    const reply = within(preview()).getByText(
      (_, element) => element?.tagName === 'P' && element.textContent === REPLY
    );
    expect(reply).toHaveClass('max-md:line-clamp-3');
  });

  it('releases the clamp while the link has keyboard focus, so a clamped-away link shows', () => {
    render(<AccessibilityPreview />);

    const reply = within(preview()).getByText(
      (_, element) => element?.tagName === 'P' && element.textContent === REPLY
    );
    expect(reply).toHaveClass('max-md:has-[:focus-visible]:line-clamp-none');
  });

  it('sticks to the top of the page scroller on its own below 768', () => {
    render(<AccessibilityPreview />);

    expect(preview()).toHaveClass('max-md:sticky', 'max-md:top-0', 'max-md:z-sticky');
  });

  it('draws no top border below 768', () => {
    render(<AccessibilityPreview />);

    expect(preview()).toHaveClass('max-md:border-t-0');
  });
});
