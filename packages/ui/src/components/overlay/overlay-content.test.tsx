import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OverlayContent } from './overlay-content';
import { OverlayPresentationContext, type OverlayPresentation } from './overlay-presentation';
import { OverlayChromeContext } from './overlay-chrome';
import type * as React from 'react';

function renderIn(presentation: OverlayPresentation, content: React.ReactNode): void {
  render(<OverlayPresentationContext value={presentation}>{content}</OverlayPresentationContext>);
}

function renderFullscreen(content: React.ReactNode): void {
  render(
    <OverlayPresentationContext value="dialog">
      <OverlayChromeContext value={{ fullscreen: true, claimTopPlacement: () => () => {} }}>
        {content}
      </OverlayChromeContext>
    </OverlayPresentationContext>
  );
}

describe('OverlayContent', () => {
  it('renders children', () => {
    render(
      <OverlayContent>
        <p>Child content</p>
      </OverlayContent>
    );

    expect(screen.getByText('Child content')).toBeInTheDocument();
  });

  it('has flex column layout with gap-4', () => {
    render(
      <OverlayContent data-testid="content">
        <p>Child</p>
      </OverlayContent>
    );

    const el = screen.getByTestId('content');
    expect(el.className).toMatch(/flex/);
    expect(el.className).toMatch(/flex-col/);
    expect(el.className).toMatch(/gap-4/);
  });

  it('has standard wrapper classes', () => {
    render(
      <OverlayContent data-testid="content">
        <p>Child</p>
      </OverlayContent>
    );

    const el = screen.getByTestId('content');
    expect(el.className).toMatch(/bg-background/);
    expect(el.className).toMatch(/rounded-lg/);
    expect(el.className).toMatch(/border/);
    expect(el.className).toMatch(/p-6/);
    expect(el.className).toMatch(/shadow-lg/);
    expect(el.className).toMatch(/w-\[90vw\]/);
  });

  it('defaults to max-w-md size', () => {
    render(
      <OverlayContent data-testid="content">
        <p>Child</p>
      </OverlayContent>
    );

    expect(screen.getByTestId('content').className).toMatch(/max-w-md/);
  });

  it('applies sm size variant', () => {
    render(
      <OverlayContent size="sm" data-testid="content">
        <p>Child</p>
      </OverlayContent>
    );

    expect(screen.getByTestId('content').className).toMatch(/max-w-sm/);
  });

  it('applies lg size variant', () => {
    render(
      <OverlayContent size="lg" data-testid="content">
        <p>Child</p>
      </OverlayContent>
    );

    expect(screen.getByTestId('content').className).toMatch(/max-w-lg/);
  });

  it('applies xl size variant', () => {
    render(
      <OverlayContent size="xl" data-testid="content">
        <p>Child</p>
      </OverlayContent>
    );

    expect(screen.getByTestId('content').className).toMatch(/max-w-xl/);
  });

  it('applies full size variant', () => {
    render(
      <OverlayContent size="full" data-testid="content">
        <p>Child</p>
      </OverlayContent>
    );

    expect(screen.getByTestId('content').className).toMatch(/max-w-4xl/);
  });

  it('caps its own height and scrolls internally so actions stay reachable', () => {
    render(
      <OverlayContent data-testid="content">
        <p>Child</p>
      </OverlayContent>
    );

    const el = screen.getByTestId('content');
    expect(el).toHaveClass('max-h-[calc(100dvh-2rem)]');
    expect(el).toHaveClass('overflow-y-auto');
  });

  it('merges className override', () => {
    render(
      <OverlayContent className="w-[75vw]" data-testid="content">
        <p>Child</p>
      </OverlayContent>
    );

    const el = screen.getByTestId('content');
    expect(el.className).toMatch(/w-\[75vw\]/);
  });

  it('passes data-testid through', () => {
    render(
      <OverlayContent data-testid="my-overlay">
        <p>Child</p>
      </OverlayContent>
    );

    expect(screen.getByTestId('my-overlay')).toBeInTheDocument();
  });

  it('wraps its text prettily', () => {
    render(<OverlayContent data-testid="content">x</OverlayContent>);

    expect(screen.getByTestId('content')).toHaveClass('text-pretty');
  });

  describe('in a dialog', () => {
    it('draws the dialog chrome', () => {
      renderIn('dialog', <OverlayContent data-testid="content">x</OverlayContent>);

      expect(screen.getByTestId('content')).toHaveClass(
        'bg-background',
        'border',
        'rounded-lg',
        'shadow-lg',
        'p-6',
        'max-w-md'
      );
    });

    it('keeps its width when tall', () => {
      renderIn(
        'dialog',
        <OverlayContent tall data-testid="content">
          x
        </OverlayContent>
      );

      expect(screen.getByTestId('content')).not.toHaveClass('h-[90dvh]');
    });
  });

  describe('in a sheet', () => {
    it('spans the sheet', () => {
      renderIn('sheet', <OverlayContent data-testid="content">x</OverlayContent>);

      const el = screen.getByTestId('content');
      expect(el).toHaveClass('w-full', 'max-w-none');
      expect(el).not.toHaveClass('max-w-md');
    });

    it('draws a 12px top radius with no border or shadow', () => {
      renderIn('sheet', <OverlayContent data-testid="content">x</OverlayContent>);

      const el = screen.getByTestId('content');
      expect(el).toHaveClass('rounded-t-xl', 'border-0', 'shadow-none');
      expect(el).not.toHaveClass('rounded-lg');
      expect(el).not.toHaveClass('shadow-lg');
    });

    it('pads its sides and bottom by 1.5rem and its top by 0.75rem', () => {
      renderIn('sheet', <OverlayContent data-testid="content">x</OverlayContent>);

      expect(screen.getByTestId('content')).toHaveClass('px-6', 'pt-3', 'pb-6');
    });

    it('shrinks to the sheet and scrolls', () => {
      renderIn('sheet', <OverlayContent data-testid="content">x</OverlayContent>);

      expect(screen.getByTestId('content')).toHaveClass('min-h-0', 'overflow-y-auto');
    });

    it('spans the sheet over a width the caller sets', () => {
      renderIn(
        'sheet',
        <OverlayContent className="w-[75vw]" data-testid="content">
          x
        </OverlayContent>
      );

      const el = screen.getByTestId('content');
      expect(el).toHaveClass('w-full');
      expect(el).not.toHaveClass('w-[75vw]');
    });

    it('keeps the caller classes that draw no chrome', () => {
      renderIn(
        'sheet',
        <OverlayContent className="gap-1 py-4" data-testid="content">
          x
        </OverlayContent>
      );

      expect(screen.getByTestId('content')).toHaveClass('gap-1', 'py-4');
    });

    it('draws the sheet chrome inside a caller wrapper element', () => {
      renderIn(
        'sheet',
        <div className="flex flex-col gap-2">
          <OverlayContent data-testid="content">x</OverlayContent>
        </div>
      );

      expect(screen.getByTestId('content')).toHaveClass('w-full', 'rounded-t-xl', 'border-0');
    });

    it('makes a tall sheet 90dvh', () => {
      renderIn(
        'sheet',
        <OverlayContent tall data-testid="content">
          x
        </OverlayContent>
      );

      expect(screen.getByTestId('content')).toHaveClass('h-[90dvh]');
    });
  });

  describe('in a full-screen dialog', () => {
    it('fills the viewport with no radius, border or shadow', () => {
      renderFullscreen(<OverlayContent data-testid="content">x</OverlayContent>);

      const el = screen.getByTestId('content');
      expect(el).toHaveClass(
        'h-full',
        'w-full',
        'max-w-none',
        'max-h-none',
        'rounded-none',
        'border-0',
        'shadow-none'
      );
    });
  });

  describe('placement', () => {
    it('claims the top placement while mounted with placement="top"', () => {
      const claims: string[] = [];
      const { unmount } = render(
        <OverlayChromeContext
          value={{
            fullscreen: false,
            claimTopPlacement: () => {
              claims.push('claim');
              return () => claims.push('release');
            },
          }}
        >
          <OverlayContent placement="top">x</OverlayContent>
        </OverlayChromeContext>
      );
      expect(claims).toEqual(['claim']);

      unmount();

      expect(claims).toEqual(['claim', 'release']);
    });

    it('claims nothing when centred', () => {
      const claims: string[] = [];
      render(
        <OverlayChromeContext
          value={{
            fullscreen: false,
            claimTopPlacement: () => {
              claims.push('claim');
              return () => {};
            },
          }}
        >
          <OverlayContent>x</OverlayContent>
        </OverlayChromeContext>
      );

      expect(claims).toEqual([]);
    });
  });

  it('leaves no descendant selector in the overlay components', () => {
    const directory = import.meta.dirname;
    const offenders = readdirSync(directory)
      .filter((name) => name.endsWith('.tsx') && !name.includes('.test.'))
      .filter((name) => readFileSync(path.join(directory, name), 'utf8').includes('[&>*]'));

    expect(offenders).toEqual([]);
  });
});
