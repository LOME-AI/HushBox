import { render } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Button } from './button';
import { buttonStackClass } from './button-group-classes';
import { ButtonStack } from './button-stack';

function stackOf(container: HTMLElement): HTMLElement {
  const stack = container.firstElementChild;
  if (!(stack instanceof HTMLElement)) throw new Error('no stack rendered');
  return stack;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ButtonStack', () => {
  it('puts the stack class on its root', () => {
    const { container } = render(
      <ButtonStack>
        <Button>Copy</Button>
      </ButtonStack>
    );

    expect(stackOf(container).className).toBe(buttonStackClass);
  });

  it('renders its buttons in markup order', () => {
    const { container } = render(
      <ButtonStack>
        <Button variant="outline">Copy</Button>
        <Button>I&apos;ve written it down</Button>
      </ButtonStack>
    );

    expect([...stackOf(container).children].map((child) => child.textContent)).toEqual([
      'Copy',
      "I've written it down",
    ]);
  });

  it('measures its widest label', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      return this.style.width === 'max-content' ? 170 : 0;
    });
    const { container } = render(
      <ButtonStack>
        <Button>Copy</Button>
      </ButtonStack>
    );

    expect(stackOf(container).style.getPropertyValue('--btn-eq')).toBe('171px');
  });

  it('marks its root to wrap labels', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      return this.textContent === 'Copy' ? 0 : 44;
    });
    const { container } = render(
      <ButtonStack>
        <Button>Copy</Button>
        <Button>I&apos;ve written it down</Button>
      </ButtonStack>
    );

    expect(stackOf(container)).toHaveAttribute('data-wrap-labels');
  });
});
