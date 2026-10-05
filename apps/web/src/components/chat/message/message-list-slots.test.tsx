import * as React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { components, HeldThroughCommit } from '@/components/chat/message/message-list-slots';
import type { ListContext } from '@/components/chat/message/message-list-slots';

const context: ListContext = {
  threadHeader: null,
  threadFooter: undefined,
  placed: true,
  onRowsShown: () => {},
};
const { List, Footer } = components;

describe('Footer', () => {
  it('renders the thread footer above its closing spacer', () => {
    const { container } = render(
      <Footer context={{ ...context, threadFooter: <p>Thread footer</p> }} />
    );
    expect(container.firstElementChild).toBe(screen.getByText('Thread footer'));
  });

  it('renders only its closing spacer when the thread has no footer', () => {
    const { container } = render(<Footer context={context} />);
    expect([...container.children].map((child) => child.getAttribute('aria-hidden'))).toEqual([
      'true',
    ]);
  });
});

describe('List', () => {
  it('hands its element to a callback ref', () => {
    const seen: (HTMLDivElement | null)[] = [];
    render(
      <List
        context={context}
        data-testid="list"
        ref={(element) => {
          seen.push(element);
        }}
      />
    );
    expect(seen).toEqual([screen.getByTestId('list')]);
  });

  it('hands its element to an object ref', () => {
    const ref = React.createRef<HTMLDivElement>();
    render(<List context={context} data-testid="list" ref={ref} />);
    expect(ref.current).toBe(screen.getByTestId('list'));
  });
});

describe('HeldThroughCommit', () => {
  /** Reads the target's held height from a layout effect, which runs inside the commit. */
  function HeightProbe({
    target,
    seen,
  }: Readonly<{ target: React.RefObject<HTMLElement | null>; seen: string[] }>): null {
    React.useLayoutEffect(() => {
      seen.push(target.current?.style.minHeight ?? 'no target');
    });
    return null;
  }

  function Holder({ label, seen }: Readonly<{ label: string; seen: string[] }>): React.JSX.Element {
    const target = React.useRef<HTMLDivElement | null>(null);
    return (
      <div ref={target}>
        <HeldThroughCommit target={target}>
          <HeightProbe target={target} seen={seen} />
          {label}
        </HeldThroughCommit>
      </div>
    );
  }

  it('holds the target at its laid-out height through a commit, then lets it go', () => {
    const seen: string[] = [];
    const { rerender, container } = render(<Holder label="before" seen={seen} />);
    const target = container.firstElementChild;
    if (!(target instanceof HTMLElement)) throw new Error('the holder drew no element');
    Object.defineProperty(target, 'offsetHeight', { configurable: true, value: 120 });
    seen.length = 0;

    rerender(<Holder label="after" seen={seen} />);

    expect(seen).toEqual(['120px']);
    expect(target.style.minHeight).toBe('');
  });

  it('commits through an update with no target', () => {
    const empty = React.createRef<HTMLElement>();
    const { rerender } = render(<HeldThroughCommit target={empty}>before</HeldThroughCommit>);
    rerender(<HeldThroughCommit target={empty}>after</HeldThroughCommit>);
    expect(screen.getByText('after')).toBeInTheDocument();
  });
});
