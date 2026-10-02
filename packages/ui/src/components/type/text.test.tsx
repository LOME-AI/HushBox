import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TYPE_ROLES, type TypeRole } from '@hushbox/shared/design-tokens';
import { Text } from './text';

const ROLES = Object.keys(TYPE_ROLES) as TypeRole[];

function textNode(content: string): HTMLElement {
  return screen.getByText(content);
}

describe('Text', () => {
  it.each(ROLES)('sets the %s role through its generated class', (role) => {
    render(<Text variant={role}>Sample</Text>);

    expect(textNode('Sample')).toHaveClass(`text-${role}`);
  });

  it.each([
    ['body', 'font-serif'],
    ['ui', 'font-sans'],
    ['mono', 'font-mono'],
  ] as const)('sets the %s role in the %s face', (role, faceClass) => {
    render(<Text variant={role}>Sample</Text>);

    expect(textNode('Sample')).toHaveClass(faceClass);
  });

  it.each(['num', 'tabular'] as const)('sets the %s role in tabular figures', (role) => {
    render(<Text variant={role}>$12.48</Text>);

    expect(textNode('$12.48')).toHaveClass('tabular-nums');
  });

  it('sets a text role in proportional figures', () => {
    render(<Text variant="ui">1,862 tokens</Text>);

    expect(textNode('1,862 tokens')).not.toHaveClass('tabular-nums');
  });

  it('renders a paragraph when no element is given', () => {
    render(<Text variant="body">A reply</Text>);

    expect(textNode('A reply').tagName).toBe('P');
  });

  it.each(['p', 'span', 'div', 'dd', 'dt', 'li'] as const)(
    'renders as the %s element given',
    (as) => {
      render(
        <Text variant="ui" as={as}>
          Sample
        </Text>
      );

      expect(textNode('Sample').tagName).toBe(as.toUpperCase());
    }
  );

  it.each([
    ['muted', 'text-muted-foreground'],
    ['signal', 'text-brand-red'],
    ['error', 'text-error'],
    ['success', 'text-success'],
    ['warning', 'text-warning'],
  ] as const)('draws the %s tone with %s', (tone, toneClass) => {
    render(
      <Text variant="ui" tone={tone}>
        Sample
      </Text>
    );

    expect(textNode('Sample')).toHaveClass(toneClass);
  });

  it('keeps the role class beside a tone class', () => {
    render(
      <Text variant="caption" tone="error">
        Sample
      </Text>
    );

    expect(textNode('Sample')).toHaveClass('text-caption', 'text-error');
  });

  it('inherits the surrounding ink for the default tone', () => {
    render(
      <Text variant="ui" tone="default">
        Sample
      </Text>
    );

    expect(textNode('Sample').className).not.toMatch(
      /\btext-(foreground|muted-foreground|brand-red|error|success|warning)\b/
    );
  });

  it.each(['body-sub', 'caption'] as const)(
    'draws the %s role muted when no tone is given',
    (role) => {
      render(<Text variant={role}>Sample</Text>);

      expect(textNode('Sample')).toHaveClass('text-muted-foreground');
    }
  );

  it('draws a muted role in the ink the default tone asks for', () => {
    render(
      <Text variant="caption" tone="default">
        Sample
      </Text>
    );

    expect(textNode('Sample')).not.toHaveClass('text-muted-foreground');
  });

  it('inherits the surrounding ink for an unmuted role when no tone is given', () => {
    render(<Text variant="body">Sample</Text>);

    expect(textNode('Sample').className).not.toMatch(/\btext-muted-foreground\b/);
  });
});
