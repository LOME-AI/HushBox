import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConsoleInput, ConsoleTextarea } from './console-fields';

/**
 * Nothing in this environment resolves a breakpoint, so width is asserted the only
 * way it is reachable: no rule on the field may ask for any size but body size. A
 * surviving `md:text-sm` is exactly the regression, because it wins at ≥768px.
 */
function sizeRules(element: HTMLElement): string[] {
  return element.className
    .split(' ')
    .filter((rule) => /^(?:sm:|md:|lg:|xl:|2xl:)?text-(?:xs|sm|base|lg|xl)$/u.test(rule));
}

describe('console fields', () => {
  it('reads a bare input at body size on every width, with no override asked for', () => {
    render(<ConsoleInput aria-label="Search findings" />);

    const rules = sizeRules(screen.getByLabelText('Search findings'));

    expect(rules).toContain('text-base');
    expect(rules.filter((rule) => !rule.endsWith('text-base'))).toEqual([]);
  });

  it('reads a bare textarea at body size on every width, with no override asked for', () => {
    render(<ConsoleTextarea aria-label="Answer" />);

    const rules = sizeRules(screen.getByLabelText('Answer'));

    expect(rules).toContain('text-base');
    expect(rules.filter((rule) => !rule.endsWith('text-base'))).toEqual([]);
  });

  it('lets a call site that names its own size win over the console default', () => {
    render(<ConsoleTextarea aria-label="Fine print" className="text-sm md:text-sm" />);

    expect(sizeRules(screen.getByLabelText('Fine print'))).toEqual(['text-sm', 'md:text-sm']);
  });
});
