import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { ScrollRegion } from './scroll-region';

/** A resize observer the test fires by hand, standing in for the browser's layout. */
class ManualResizeObserver implements ResizeObserver {
  static readonly instances: ManualResizeObserver[] = [];
  disconnected = false;
  constructor(private readonly callback: ResizeObserverCallback) {
    ManualResizeObserver.instances.push(this);
  }
  observe(): void {
    /* the test fires it */
  }
  unobserve(): void {
    /* the test fires it */
  }
  disconnect(): void {
    this.disconnected = true;
  }
  fire(): void {
    this.callback([], this);
  }
}

/** Lays every element out with content this many pixels wide inside a 300px box. */
function layOutContentWidth(width: number): void {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(width);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  ManualResizeObserver.instances.length = 0;
});

describe('ScrollRegion', () => {
  it('is a tab stop', () => {
    render(<ScrollRegion label="Pages by visitors">content</ScrollRegion>);
    expect(screen.getByRole('group')).toHaveAttribute('tabindex', '0');
  });

  it('is named by its label', () => {
    render(<ScrollRegion label="Pages by visitors">content</ScrollRegion>);
    expect(screen.getByRole('group', { name: 'Pages by visitors' })).toBeInTheDocument();
  });

  it('renders a div when not asked to take its child', () => {
    render(<ScrollRegion label="Pages by visitors">content</ScrollRegion>);
    expect(screen.getByRole('group').tagName).toBe('DIV');
  });

  it('marks itself with the scroll-region data-slot', () => {
    render(<ScrollRegion label="Pages by visitors">content</ScrollRegion>);
    expect(screen.getByRole('group')).toHaveAttribute('data-slot', 'scroll-region');
  });

  it('draws a focus ring on keyboard focus', () => {
    render(<ScrollRegion label="Pages by visitors">content</ScrollRegion>);
    expect(screen.getByRole('group')).toHaveClass(
      'focus-visible:ring-ring',
      'focus-visible:ring-2'
    );
  });

  it('hides the browser outline only while it has keyboard focus', () => {
    render(<ScrollRegion label="Pages by visitors">content</ScrollRegion>);
    expect(
      [...screen.getByRole('group').classList].filter((token) =>
        /(^|:)outline-(none|hidden)$/.test(token)
      )
    ).toEqual(['focus-visible:outline-hidden']);
  });

  it('adds no radius of its own, because a box that paints nothing at rest should add no shape', () => {
    render(<ScrollRegion label="Pages by visitors">content</ScrollRegion>);
    expect(screen.getByRole('group').className).not.toMatch(/(^|\s)rounded(-|\s|$)/);
  });

  it('is positioned, because absolutely positioned screen-reader text inside it is clipped by it only when it is that text’s containing block', () => {
    render(<ScrollRegion label="Pages by visitors">content</ScrollRegion>);
    expect(screen.getByRole('group')).toHaveClass('relative');
  });

  it('renders its one child as the region when asChild is set', () => {
    render(
      <ScrollRegion label="Source lines" asChild>
        <pre>code</pre>
      </ScrollRegion>
    );
    expect(screen.getByRole('group', { name: 'Source lines' }).tagName).toBe('PRE');
  });

  it('keeps the child element’s own classes when asChild is set', () => {
    render(
      <ScrollRegion label="Source lines" asChild>
        <pre className="overflow-x-auto">code</pre>
      </ScrollRegion>
    );
    expect(screen.getByRole('group')).toHaveClass('overflow-x-auto', 'focus-visible:ring-2');
  });

  it('lets a caller’s className win over its own', () => {
    render(
      <ScrollRegion label="Pages by visitors" className="overflow-auto focus-visible:ring-0">
        content
      </ScrollRegion>
    );
    const region = screen.getByRole('group');
    expect(region).toHaveClass('focus-visible:ring-0', 'overflow-auto');
    expect(region).not.toHaveClass('focus-visible:ring-2');
  });

  it('lets a caller’s data-slot win over its own', () => {
    render(
      <ScrollRegion label="Pages by visitors" data-slot="pages-scrollport">
        content
      </ScrollRegion>
    );
    expect(screen.getByRole('group')).toHaveAttribute('data-slot', 'pages-scrollport');
  });

  it('hands a ref the region element', () => {
    const ref = React.createRef<HTMLDivElement>();
    render(
      <ScrollRegion label="Pages by visitors" ref={ref}>
        content
      </ScrollRegion>
    );
    expect(ref.current).toBe(screen.getByRole('group'));
  });

  it('hands a ref the child element when asChild is set', () => {
    const ref = React.createRef<HTMLDivElement>();
    render(
      <ScrollRegion label="Source lines" asChild ref={ref}>
        <pre>code</pre>
      </ScrollRegion>
    );
    expect(ref.current).toBe(screen.getByRole('group'));
  });

  describe('with a tab stop only while it overflows', () => {
    it('renders the tab stop in server HTML, so a reader without script can still reach it', () => {
      const html = renderToString(
        <ScrollRegion label="Pages by visitors" tabStop="overflow">
          content
        </ScrollRegion>
      );
      expect(html).toContain('tabindex="0"');
    });

    it('drops the tab stop once it measures content that fits', () => {
      vi.stubGlobal('ResizeObserver', ManualResizeObserver);
      layOutContentWidth(300);
      render(
        <ScrollRegion label="Pages by visitors" tabStop="overflow">
          content
        </ScrollRegion>
      );
      expect(screen.getByRole('group')).not.toHaveAttribute('tabindex');
    });

    it('keeps the tab stop while its content is wider than it', () => {
      vi.stubGlobal('ResizeObserver', ManualResizeObserver);
      layOutContentWidth(420);
      render(
        <ScrollRegion label="Pages by visitors" tabStop="overflow">
          content
        </ScrollRegion>
      );
      expect(screen.getByRole('group')).toHaveAttribute('tabindex', '0');
    });

    it('becomes a tab stop when a resize makes its content overflow', () => {
      vi.stubGlobal('ResizeObserver', ManualResizeObserver);
      layOutContentWidth(300);
      render(
        <ScrollRegion label="Pages by visitors" tabStop="overflow">
          content
        </ScrollRegion>
      );
      expect(screen.getByRole('group')).not.toHaveAttribute('tabindex');
      layOutContentWidth(420);
      for (const observer of ManualResizeObserver.instances) observer.fire();
      expect(screen.getByRole('group')).toHaveAttribute('tabindex', '0');
    });

    it('keeps its group role and name while it is a tab stop', () => {
      vi.stubGlobal('ResizeObserver', ManualResizeObserver);
      layOutContentWidth(420);
      render(
        <ScrollRegion label="Pages by visitors" tabStop="overflow">
          content
        </ScrollRegion>
      );
      expect(screen.getByRole('group', { name: 'Pages by visitors' })).toHaveAttribute(
        'tabindex',
        '0'
      );
    });

    it('stops measuring when it unmounts', () => {
      vi.stubGlobal('ResizeObserver', ManualResizeObserver);
      const { unmount } = render(
        <ScrollRegion label="Pages by visitors" tabStop="overflow">
          content
        </ScrollRegion>
      );
      unmount();
      expect(ManualResizeObserver.instances.map((observer) => observer.disconnected)).toEqual([
        true,
      ]);
    });

    it('hands an object ref the region element', () => {
      vi.stubGlobal('ResizeObserver', ManualResizeObserver);
      const ref = React.createRef<HTMLDivElement>();
      render(
        <ScrollRegion label="Pages by visitors" tabStop="overflow" ref={ref}>
          content
        </ScrollRegion>
      );
      expect(ref.current).toBe(screen.getByRole('group'));
    });

    it('hands a callback ref the region element', () => {
      vi.stubGlobal('ResizeObserver', ManualResizeObserver);
      const received: (HTMLDivElement | null)[] = [];
      render(
        <ScrollRegion
          label="Pages by visitors"
          tabStop="overflow"
          ref={(node) => {
            received.push(node);
          }}
        >
          content
        </ScrollRegion>
      );
      expect(received).toContain(screen.getByRole('group'));
    });

    it('measures the child it renders as the region when asChild is set', () => {
      vi.stubGlobal('ResizeObserver', ManualResizeObserver);
      layOutContentWidth(300);
      render(
        <ScrollRegion label="Source lines" tabStop="overflow" asChild>
          <pre>code</pre>
        </ScrollRegion>
      );
      expect(screen.getByRole('group')).not.toHaveAttribute('tabindex');
    });
  });

  it('never measures when it is always a tab stop', () => {
    vi.stubGlobal('ResizeObserver', ManualResizeObserver);
    layOutContentWidth(300);
    render(<ScrollRegion label="Pages by visitors">content</ScrollRegion>);
    expect(ManualResizeObserver.instances).toHaveLength(0);
  });
});
