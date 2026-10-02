import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { TYPE_ROLES, type TypeRole } from '@hushbox/shared/design-tokens';
import typeSection from './type.section';

const ROLES = Object.keys(TYPE_ROLES) as TypeRole[];

function renderSection(): void {
  render(<>{typeSection.render()}</>);
}

/** The sample the kit draws under a role's name. */
function sampleFor(role: TypeRole): HTMLElement {
  const term = screen.getByText(role, { selector: 'dt' });
  const description = term.nextElementSibling;
  if (!(description instanceof HTMLElement)) throw new Error(`no sample under ${role}`);
  return within(description).getByText(/./, { selector: `.text-${role}` });
}

describe('the type kit section', () => {
  it('is compared against catalog part 1', () => {
    expect(typeSection.part).toBe(1);
  });

  it.each(ROLES)('draws a sample of the %s role under its name', (role) => {
    renderSection();

    expect(sampleFor(role)).toHaveClass(`text-${role}`);
  });

  it('draws a heading in the ink tone', () => {
    renderSection();

    expect(screen.getByRole('heading', { name: 'Welcome back' })).toHaveClass('text-foreground');
  });

  it.each([
    ['muted', 'text-muted-foreground'],
    ['signal', 'text-brand-red'],
    ['error', 'text-error'],
    ['success', 'text-success'],
    ['warning', 'text-warning'],
  ])('draws text in the %s tone', (tone, toneClass) => {
    renderSection();

    expect(screen.getByText(`The ${tone} tone`)).toHaveClass(toneClass);
  });
});
