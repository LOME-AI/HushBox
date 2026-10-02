import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TYPE_ROLES, type TypeRole } from '@hushbox/shared/design-tokens';
import { Heading } from './heading';

const ROLES = Object.keys(TYPE_ROLES) as TypeRole[];

describe('Heading', () => {
  it.each([1, 2, 3, 4, 5, 6] as const)('renders an h%i for level %i', (level) => {
    render(
      <Heading level={level} variant="title-2">
        How billing works
      </Heading>
    );

    expect(screen.getByRole('heading', { level, name: 'How billing works' })).toBeInTheDocument();
  });

  it.each(ROLES)('sets the %s role through its generated class', (role) => {
    render(
      <Heading level={2} variant={role}>
        Heading
      </Heading>
    );

    expect(screen.getByRole('heading')).toHaveClass(`text-${role}`);
  });

  it('sets a serif role in the serif face', () => {
    render(
      <Heading level={1} variant="title-1">
        Where does my money go?
      </Heading>
    );

    expect(screen.getByRole('heading')).toHaveClass('font-serif');
  });

  it('sets a sans role in the sans face, over the serif every heading element defaults to', () => {
    render(
      <Heading level={4} variant="title-3">
        Current Balance
      </Heading>
    );

    expect(screen.getByRole('heading')).toHaveClass('font-sans');
    expect(screen.getByRole('heading')).not.toHaveClass('font-serif');
  });

  it('leaves the Signal Red to the heading element rule when no tone is given', () => {
    render(
      <Heading level={2} variant="title-2">
        How billing works
      </Heading>
    );

    expect(screen.getByRole('heading').className).not.toMatch(/\btext-(foreground|brand-red)\b/);
  });

  it('leaves the Signal Red to the heading element rule for the signal tone', () => {
    render(
      <Heading level={2} variant="title-2" tone="signal">
        How billing works
      </Heading>
    );

    expect(screen.getByRole('heading').className).not.toMatch(/\btext-(foreground|brand-red)\b/);
  });

  it('draws the ink tone in the foreground ink', () => {
    render(
      <Heading level={1} variant="title-1" tone="ink">
        Welcome back
      </Heading>
    );

    expect(screen.getByRole('heading')).toHaveClass('text-foreground');
  });

  it('keeps the role class beside the ink tone', () => {
    render(
      <Heading level={3} variant="title-3" tone="ink">
        Daily messages
      </Heading>
    );

    expect(screen.getByRole('heading')).toHaveClass('text-title-3', 'text-foreground');
  });

  it('carries the id it is given, so a region can be labelled by it', () => {
    render(
      <section aria-labelledby="billing-heading">
        <Heading level={2} variant="title-2" id="billing-heading">
          How billing works
        </Heading>
      </section>
    );

    expect(screen.getByRole('region', { name: 'How billing works' })).toBeInTheDocument();
  });

  it('requires a level', () => {
    // @ts-expect-error -- the outline level is required: a role sets only how a heading looks
    const element = <Heading variant="title-1">No level</Heading>;

    expect(element.props).not.toHaveProperty('level');
  });

  it('wraps onto more lines by default', () => {
    render(
      <Heading level={1} variant="header-title">
        Lisbon trip planning
      </Heading>
    );

    expect(screen.getByRole('heading')).not.toHaveClass('truncate');
  });

  it('draws one line with an ellipsis when asked to truncate', () => {
    render(
      <Heading level={1} variant="header-title" truncate>
        Lisbon trip planning
      </Heading>
    );

    expect(screen.getByRole('heading')).toHaveClass('truncate');
  });

  it('keeps the role class beside the truncation', () => {
    render(
      <Heading level={1} variant="header-title" truncate>
        Lisbon trip planning
      </Heading>
    );

    expect(screen.getByRole('heading')).toHaveClass('text-header-title', 'font-sans');
  });
});
