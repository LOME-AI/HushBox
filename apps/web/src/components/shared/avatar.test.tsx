import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Avatar } from './avatar';

function avatarIn(container: HTMLElement): HTMLElement {
  const avatar = container.querySelector<HTMLElement>('[data-slot="avatar"]');
  if (avatar === null) throw new Error('no avatar drawn');
  return avatar;
}

describe('Avatar', () => {
  it('shows the first character of the name', () => {
    const { container } = render(<Avatar name="Alice" />);

    expect(avatarIn(container)).toHaveTextContent(/^A$/);
  });

  it('keeps a first character that spans two code units whole', () => {
    const { container } = render(<Avatar name="😀 Zed" />);

    expect(avatarIn(container)).toHaveTextContent(/^😀$/);
  });

  it('keeps a first character joined from several emoji whole', () => {
    const { container } = render(<Avatar name="👩‍💻 Dev" />);

    expect(avatarIn(container)).toHaveTextContent(/^👩‍💻$/);
  });

  it('draws an empty disc for an empty name', () => {
    const { container } = render(<Avatar name="" />);

    expect(avatarIn(container)).toBeEmptyDOMElement();
  });

  it('draws a 1.75rem circle with a bold initial', () => {
    const { container } = render(<Avatar name="Alice" />);

    expect(avatarIn(container)).toHaveClass(
      'size-7',
      'rounded-full',
      'bg-secondary',
      'text-foreground',
      'text-xs',
      'font-bold'
    );
  });

  it('centres its initial', () => {
    const { container } = render(<Avatar name="Alice" />);

    expect(avatarIn(container)).toHaveClass('inline-grid', 'place-items-center', 'shrink-0');
  });

  it('is hidden from assistive tech, since a name always sits beside it', () => {
    const { container } = render(<Avatar name="Alice" />);

    expect(avatarIn(container)).toHaveAttribute('aria-hidden', 'true');
  });

  it('names the person on hover', () => {
    const { container } = render(<Avatar name="Alice" />);

    expect(avatarIn(container)).toHaveAttribute('title', 'Alice');
  });

  it('draws a success ring when the person is online', () => {
    const { container } = render(<Avatar name="Alice" online />);

    const avatar = avatarIn(container);
    expect(avatar).toHaveAttribute('data-online');
    expect(avatar).toHaveClass('shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--success)]');
  });

  it('says the person is online on hover', () => {
    const { container } = render(<Avatar name="Alice" online />);

    expect(avatarIn(container)).toHaveAttribute('title', 'Alice, online');
  });

  it('draws no ring when the person is offline', () => {
    const { container } = render(<Avatar name="Alice" online={false} />);

    const avatar = avatarIn(container);
    expect(avatar).not.toHaveAttribute('data-online');
    expect(avatar.className).not.toContain('var(--success)');
  });

  describe('person', () => {
    it('shows a person icon instead of an initial', () => {
      const { container } = render(<Avatar person />);

      const avatar = avatarIn(container);
      expect(avatar.querySelector('svg')).not.toBeNull();
      expect(avatar).toHaveTextContent('');
    });

    it('draws the account avatar: 2rem on the subtle fill in muted ink', () => {
      const { container } = render(<Avatar person />);

      expect(avatarIn(container)).toHaveClass(
        'size-8',
        'rounded-full',
        'bg-background-subtle',
        'text-muted-foreground'
      );
    });

    it('draws its icon at 1rem', () => {
      const { container } = render(<Avatar person />);

      expect(avatarIn(container).querySelector('svg')).toHaveClass('size-4');
    });

    it('is hidden from assistive tech', () => {
      const { container } = render(<Avatar person />);

      expect(avatarIn(container)).toHaveAttribute('aria-hidden', 'true');
    });
  });
});
