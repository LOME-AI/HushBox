import * as React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Notice, type NoticeProps, type NoticeTone } from './notice';
import { OverlayPresentationContext } from '../overlay/overlay-presentation';
import { BUTTON_GROUP_MARKER } from '../button/button-group-classes';
import type { IconGlyphProps } from '../icons/icon';

function Glyph(props: Readonly<IconGlyphProps>): React.JSX.Element {
  return <svg data-testid="notice-glyph" {...props} />;
}

type RenderProps = Omit<NoticeProps, 'icon' | 'data-testid'>;

function renderNotice(props: Readonly<RenderProps>): HTMLElement {
  render(<Notice icon={Glyph} data-testid="notice" {...props} />);
  return screen.getByTestId('notice');
}

function renderInOverlay(props: Readonly<RenderProps>): HTMLElement {
  render(
    <OverlayPresentationContext value="dialog">
      <Notice icon={Glyph} data-testid="notice" {...props} />
    </OverlayPresentationContext>
  );
  return screen.getByTestId('notice');
}

const TONES: readonly NoticeTone[] = ['neutral', 'info', 'success', 'warning', 'error', 'brand'];

describe('Notice', () => {
  describe('content', () => {
    it('leads with the cause in semibold', () => {
      renderNotice({ tone: 'error', title: 'Your balance is too low.' });

      expect(screen.getByText('Your balance is too low.')).toHaveClass('font-semibold');
    });

    it('follows with the action sentence in regular weight', () => {
      renderNotice({ tone: 'error', title: 'Cause.', children: 'Add credit to continue.' });

      expect(screen.getByText('Add credit to continue.')).toHaveClass('font-normal');
    });

    it('draws the icon it is given, hidden from assistive technology', () => {
      renderNotice({ tone: 'info', children: 'Text' });

      expect(screen.getByTestId('notice-glyph')).toHaveAttribute('aria-hidden', 'true');
    });

    it('draws a linked action as an inline red link', () => {
      renderNotice({ tone: 'info', children: <a href="/billing">Add credit</a> });

      expect(screen.getByRole('link').parentElement?.parentElement).toHaveClass(
        '[&_a]:text-primary',
        '[&_a]:underline-offset-4',
        '[&_a:hover]:underline'
      );
    });

    it.each(['inline', 'composer', 'tile', 'slot'] as const)(
      'breaks a word too long for its column when placed %s',
      (placement) => {
        const notice = renderNotice({ tone: 'error', placement, title: 'Cause.' });

        expect(notice.children[1]).toHaveClass('wrap-break-word');
      }
    );

    it('draws the corner control after the text', () => {
      renderNotice({
        tone: 'warning',
        children: 'Text',
        end: <button type="button">Close</button>,
      });

      const notice = screen.getByTestId('notice');
      const button = screen.getByRole('button', { name: 'Close' });
      expect(notice.lastElementChild).toContainElement(button);
    });

    it('marks its tone and placement on the element', () => {
      const notice = renderNotice({ tone: 'warning', placement: 'tile', children: 'Text' });

      expect(notice).toHaveAttribute('data-tone', 'warning');
      expect(notice).toHaveAttribute('data-placement', 'tile');
    });
  });

  describe('the base look', () => {
    it('sits on the neutral well with a hairline edge', () => {
      const notice = renderNotice({ tone: 'info', children: 'Text' });

      expect(notice).toHaveClass(
        'grid',
        'items-center',
        'gap-x-2.5',
        'gap-y-3',
        'rounded-lg',
        'border',
        'bg-muted/50',
        'px-3.5',
        'py-3',
        'text-sm',
        'leading-[1.45]',
        'text-foreground'
      );
    });

    it.each([
      ['neutral', 'border-border', 'text-muted-foreground'],
      ['info', 'border-info/36', 'text-info'],
      ['success', 'border-success/36', 'text-success'],
      ['warning', 'border-warning/40', 'text-warning'],
      ['error', 'border-error/36', 'text-error'],
      ['brand', 'border-brand-red/36', 'text-brand-red'],
    ] as const satisfies readonly (readonly [NoticeTone, string, string])[])(
      'draws the %s tone as its hairline and its icon ink',
      (tone, edge, ink) => {
        const notice = renderNotice({ tone, children: 'Text' });

        expect(notice).toHaveClass(edge);
        expect(screen.getByTestId('notice-glyph')).toHaveClass(ink);
      }
    );

    it('gives the text the full width when it has no corner control', () => {
      const notice = renderNotice({ tone: 'info', children: 'Text' });

      expect(notice).toHaveClass('grid-cols-[auto_minmax(0,1fr)]');
      expect(notice).not.toHaveClass('grid-cols-[auto_minmax(0,1fr)_auto]');
    });

    it('keeps a third column for a corner control', () => {
      const notice = renderNotice({ tone: 'info', children: 'Text', end: <span>End</span> });

      expect(notice).toHaveClass('grid-cols-[auto_minmax(0,1fr)_auto]');
    });

    it('sets a slot notice in the base look, a little below the slot head', () => {
      const notice = renderNotice({ tone: 'error', placement: 'slot', children: 'Text' });

      expect(notice).toHaveClass('grid', 'border', 'border-error/36', 'bg-muted/50', 'mt-0.5');
    });
  });

  describe('in the composer', () => {
    it("draws today's composer notice", () => {
      const notice = renderNotice({ tone: 'warning', placement: 'composer', children: 'Text' });

      expect(notice).toHaveClass(
        'flex',
        'items-center',
        'gap-2',
        'rounded',
        'px-3',
        'py-2',
        'text-sm',
        'bg-muted/50',
        'text-foreground',
        'border-l-3'
      );
    });

    it.each([
      ['neutral', 'border-l-muted-foreground'],
      ['info', 'border-l-info'],
      ['success', 'border-l-success'],
      ['warning', 'border-l-warning'],
      ['error', 'border-l-error'],
      ['brand', 'border-l-brand-red'],
    ] as const satisfies readonly (readonly [NoticeTone, string])[])(
      'draws the %s tone as a strip at the left edge in place of the hairline',
      (tone, strip) => {
        const notice = renderNotice({ tone, placement: 'composer', children: 'Text' });

        expect(notice).toHaveClass(strip);
        expect(notice).not.toHaveClass('border');
      }
    );

    it('reads the cause in regular weight, one run with the action', () => {
      renderNotice({ tone: 'error', placement: 'composer', title: 'Cause.', children: 'Action.' });

      expect(screen.getByText('Cause.')).toHaveClass('font-normal');
    });

    it("keeps a link's words on one line", () => {
      renderNotice({
        tone: 'error',
        placement: 'composer',
        children: <a href="/billing">Add credit</a>,
      });

      expect(screen.getByRole('link').parentElement?.parentElement).toHaveClass(
        '[&_a]:whitespace-nowrap'
      );
    });

    it('draws a one-rem icon', () => {
      renderNotice({ tone: 'info', placement: 'composer', children: 'Text' });

      expect(screen.getByTestId('notice-glyph')).toHaveClass('size-4');
    });
  });

  describe('in the thread', () => {
    it('sets its icon in a disc tinted with the tone', () => {
      renderNotice({ tone: 'error', placement: 'tile', children: 'Text' });

      expect(screen.getByTestId('notice-glyph').parentElement).toHaveClass(
        'size-9',
        'rounded-full',
        'bg-error/14',
        'text-error'
      );
    });

    it('reads the cause a step larger', () => {
      renderNotice({ tone: 'error', placement: 'tile', title: 'Cause.', children: 'Action.' });

      expect(screen.getByText('Cause.')).toHaveClass('text-[0.9375rem]', 'leading-[1.4]');
    });

    it('reads the action in muted ink', () => {
      renderNotice({ tone: 'error', placement: 'tile', title: 'Cause.', children: 'Action.' });

      expect(screen.getByText('Action.')).toHaveClass('text-muted-foreground');
    });

    it('pads the tile a step more than the base', () => {
      const notice = renderNotice({ tone: 'error', placement: 'tile', children: 'Text' });

      expect(notice).toHaveClass('p-4', 'gap-x-3', 'gap-y-3.5');
    });

    it('lays its actions out in a button row spanning the tile', () => {
      renderNotice({
        tone: 'error',
        placement: 'tile',
        children: 'Text',
        actions: <button type="button">Regenerate</button>,
      });

      const row = screen.getByRole('button', { name: 'Regenerate' }).parentElement;
      expect(row).toHaveClass(BUTTON_GROUP_MARKER);
      expect(row?.parentElement).toHaveClass('col-span-full');
    });
  });

  describe('outside the thread', () => {
    it('lays actions out under the text column', () => {
      renderNotice({
        tone: 'info',
        children: 'Text',
        actions: <button type="button">Retry</button>,
      });

      const row = screen.getByRole('button', { name: 'Retry' }).parentElement;
      expect(row?.parentElement).toHaveClass('col-start-2', '-col-end-1');
    });
  });

  describe('inside an overlay', () => {
    it('draws the default alert subtly when no emphasis is named', () => {
      const notice = renderInOverlay({ tone: 'warning', children: 'Text' });

      expect(notice).toHaveClass('text-muted-foreground', 'border-transparent');
      expect(notice).not.toHaveClass('bg-muted/50');
    });

    it('draws the default alert on the filled well at strong emphasis', () => {
      const notice = renderInOverlay({ tone: 'warning', emphasis: 'strong', children: 'Text' });

      expect(notice).toHaveClass('bg-muted', 'text-foreground');
    });

    it('draws the destructive alert strongly when no emphasis is named', () => {
      const notice = renderInOverlay({ tone: 'error', destructive: true, children: 'Text' });

      expect(notice).toHaveClass('bg-destructive/10', 'text-destructive');
    });

    it('draws the destructive alert with no fill at subtle emphasis', () => {
      const notice = renderInOverlay({
        tone: 'error',
        destructive: true,
        emphasis: 'subtle',
        children: 'Text',
      });

      expect(notice).toHaveClass('text-destructive');
      expect(notice).not.toHaveClass('bg-destructive/10');
    });

    it("draws no edge in the tone's colour", () => {
      const notice = renderInOverlay({ tone: 'warning', children: 'Text' });

      expect(notice).not.toHaveClass('border-warning/40');
    });

    it('draws the icon in the text colour', () => {
      renderInOverlay({ tone: 'warning', children: 'Text' });

      const glyph = screen.getByTestId('notice-glyph');
      expect(glyph).toHaveClass('text-current');
      expect(glyph).not.toHaveClass('text-warning');
    });

    it('keeps the thread look for a tile', () => {
      const notice = renderInOverlay({ tone: 'error', placement: 'tile', children: 'Text' });

      expect(notice).toHaveClass('border-error/36', 'p-4');
    });
  });

  describe('outside an overlay, with an emphasis or destructive named', () => {
    it('draws the default alert subtly', () => {
      const notice = renderNotice({ tone: 'neutral', emphasis: 'subtle', children: 'Text' });

      expect(notice).toHaveClass('text-muted-foreground', 'border-transparent');
      expect(notice).not.toHaveClass('bg-muted/50');
    });

    it('draws the default alert on the filled well at strong emphasis', () => {
      const notice = renderNotice({ tone: 'neutral', emphasis: 'strong', children: 'Text' });

      expect(notice).toHaveClass('bg-muted', 'text-foreground', 'border-transparent');
    });

    it('draws the destructive alert strongly when no emphasis is named', () => {
      const notice = renderNotice({ tone: 'error', destructive: true, children: 'Text' });

      expect(notice).toHaveClass('bg-destructive/10', 'text-destructive', 'border-transparent');
    });

    it('draws the destructive alert with no fill at subtle emphasis', () => {
      const notice = renderNotice({
        tone: 'error',
        destructive: true,
        emphasis: 'subtle',
        children: 'Text',
      });

      expect(notice).toHaveClass('text-destructive', 'border-transparent');
      expect(notice).not.toHaveClass('bg-destructive/10');
    });

    it('draws the icon in the text colour', () => {
      renderNotice({ tone: 'error', destructive: true, children: 'Text' });

      expect(screen.getByTestId('notice-glyph')).toHaveClass('text-current');
    });

    it('draws the pair an overlay draws for an explicit destructive false', () => {
      render(
        <>
          <OverlayPresentationContext value="dialog">
            <Notice icon={Glyph} tone="warning" destructive={false} data-testid="inside">
              Text
            </Notice>
          </OverlayPresentationContext>
          <Notice icon={Glyph} tone="warning" destructive={false} data-testid="outside">
            Text
          </Notice>
        </>
      );

      expect(screen.getByTestId('outside').className).toBe(screen.getByTestId('inside').className);
    });

    it('keeps the tone look when neither is named', () => {
      const notice = renderNotice({ tone: 'error', children: 'Text' });

      expect(notice).toHaveClass('bg-muted/50', 'border-error/36');
    });

    it.each(['composer', 'tile', 'slot'] as const)(
      'ignores both in the %s placement',
      (placement) => {
        const notice = renderNotice({
          tone: 'error',
          placement,
          destructive: true,
          emphasis: 'strong',
          children: 'Text',
        });

        expect(notice).toHaveClass('bg-muted/50');
        expect(notice).not.toHaveClass('bg-destructive/10');
      }
    );
  });

  describe('the success icon', () => {
    it('puts the success ink on the icon', () => {
      renderNotice({ tone: 'warning', iconTone: 'success', children: 'Text' });

      const glyph = screen.getByTestId('notice-glyph');
      expect(glyph).toHaveClass('text-success');
      expect(glyph).not.toHaveClass('text-warning');
    });

    it("keeps the tone's well and edge", () => {
      const notice = renderNotice({ tone: 'warning', iconTone: 'success', children: 'Text' });

      expect(notice).toHaveClass('bg-muted/50', 'border-warning/40');
    });

    it('puts the success ink on the icon inside an overlay', () => {
      renderInOverlay({ tone: 'neutral', iconTone: 'success', children: 'Text' });

      const glyph = screen.getByTestId('notice-glyph');
      expect(glyph).toHaveClass('text-success');
      expect(glyph).not.toHaveClass('text-current');
    });
  });

  describe('its live role', () => {
    it('interrupts for an error', () => {
      expect(renderNotice({ tone: 'error', children: 'Text' })).toHaveAttribute('role', 'alert');
    });

    it.each(TONES.filter((tone) => tone !== 'error'))('waits its turn for a %s notice', (tone) => {
      expect(renderNotice({ tone, children: 'Text' })).toHaveAttribute('role', 'status');
    });

    it('waits its turn for a warning in the composer', () => {
      const notice = renderNotice({ tone: 'warning', placement: 'composer', children: 'Text' });

      expect(notice).toHaveAttribute('role', 'status');
    });

    it('interrupts for a destructive alert in an overlay', () => {
      const notice = renderInOverlay({ tone: 'warning', destructive: true, children: 'Text' });

      expect(notice).toHaveAttribute('role', 'alert');
    });

    it('interrupts for a destructive alert outside an overlay', () => {
      const notice = renderNotice({ tone: 'warning', destructive: true, children: 'Text' });

      expect(notice).toHaveAttribute('role', 'alert');
    });

    it('waits its turn for a destructive slot, which ignores destructive', () => {
      const notice = renderNotice({
        tone: 'warning',
        placement: 'slot',
        destructive: true,
        children: 'Text',
      });

      expect(notice).toHaveAttribute('role', 'status');
    });

    it('takes no role when its live region is off', () => {
      const notice = renderNotice({ tone: 'error', live: 'off', children: 'Text' });

      expect(notice).not.toHaveAttribute('role');
    });
  });

  describe('its text test id', () => {
    it('reads the cause, one space, then the action, without the actions', () => {
      renderNotice({
        tone: 'error',
        placement: 'slot',
        title: 'This model stopped.',
        children: 'Try again.',
        actions: <button type="button">Regenerate</button>,
        textTestId: 'notice-text',
      });

      expect(screen.getByTestId('notice-text').textContent).toBe('This model stopped. Try again.');
    });

    it('marks nothing in the text block when none is given', () => {
      const notice = renderNotice({ tone: 'error', title: 'Cause.', children: 'Action.' });

      const marked = [...notice.querySelectorAll<HTMLElement>('[data-testid]')].map(
        (element) => element.dataset['testid']
      );
      expect(marked).toEqual(['notice-glyph']);
    });
  });

  describe('a tile too narrow for its words', () => {
    /** Records each resize observer the notice creates, so a test can report a resize. */
    class RecordingResizeObserver implements ResizeObserver {
      static readonly instances: RecordingResizeObserver[] = [];
      readonly observed: Element[] = [];
      disconnected = false;
      constructor(private readonly callback: ResizeObserverCallback) {
        RecordingResizeObserver.instances.push(this);
      }
      observe(target: Element): void {
        this.observed.push(target);
      }
      unobserve(): void {
        /* the notice never unobserves one element */
      }
      disconnect(): void {
        this.disconnected = true;
      }
      resize(): void {
        this.callback([], this);
      }
    }

    // A test DOM lays nothing out: the text track and the text size come from a stylesheet,
    // and the text block reads `wordWidth` only while it is laid out at its min-content width.
    let wordWidth = 0;
    const tracks = document.createElement('style');

    function textTrack(width: number, fontSize = 10): void {
      tracks.textContent = `[data-slot="notice"] { grid-template-columns: 36px ${String(width)}px 28px; font-size: ${String(fontSize)}px; }`;
    }

    function tileObserver(tile: HTMLElement): RecordingResizeObserver {
      const observer = RecordingResizeObserver.instances.find((instance) =>
        instance.observed.includes(tile)
      );
      if (observer === undefined) throw new Error('nothing observes the tile');
      return observer;
    }

    /** Reports a resize to the tile's observer with the timers held, so a test says when they run. */
    function resizeTile(tile: HTMLElement): void {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      tileObserver(tile).resize();
    }

    function renderTile(props: Partial<RenderProps> = {}): HTMLElement {
      return renderNotice({
        tone: 'error',
        placement: 'tile',
        title: 'This service is temporarily unavailable.',
        ...props,
      });
    }

    beforeEach(() => {
      RecordingResizeObserver.instances.length = 0;
      vi.stubGlobal('ResizeObserver', RecordingResizeObserver);
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: HTMLElement
      ) {
        return new DOMRect(0, 0, this.style.width === 'min-content' ? wordWidth : 0, 0);
      });
      document.head.append(tracks);
      textTrack(100);
      wordWidth = 80;
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      tracks.remove();
      Reflect.deleteProperty(document, 'fonts');
      document.documentElement.removeAttribute('class');
    });

    it('stacks when its widest word is wider than its text column', () => {
      wordWidth = 101;

      expect(renderTile()).toHaveAttribute('data-stacked');
    });

    it('stays side by side when its widest word fits its text column', () => {
      wordWidth = 100;

      expect(renderTile()).not.toHaveAttribute('data-stacked');
    });

    it('stacks when its text column is narrower than six of its ems', () => {
      textTrack(119, 20);
      wordWidth = 40;

      expect(renderTile()).toHaveAttribute('data-stacked');
    });

    it('stays side by side when its text column holds six of its ems', () => {
      textTrack(120, 20);
      wordWidth = 40;

      expect(renderTile()).not.toHaveAttribute('data-stacked');
    });

    it('gives its text back its own width after measuring it', () => {
      renderTile();

      expect(
        screen.getByText('This service is temporarily unavailable.').parentElement
      ).not.toHaveAttribute('style');
    });

    it.each(['inline', 'slot', 'composer'] as const)(
      'never stacks a notice placed %s',
      (placement) => {
        wordWidth = 500;

        expect(renderTile({ placement })).not.toHaveAttribute('data-stacked');
      }
    );

    it('moves its text under the icon and the corner control while stacked', () => {
      renderTile();

      expect(
        screen.getByText('This service is temporarily unavailable.').parentElement
      ).toHaveClass(
        'group-data-stacked/notice:col-start-1',
        'group-data-stacked/notice:-col-end-1',
        'group-data-stacked/notice:row-start-2'
      );
    });

    it('measures again when the tile resizes', () => {
      const tile = renderTile();

      textTrack(60);
      resizeTile(tile);
      vi.runOnlyPendingTimers();

      expect(tile).toHaveAttribute('data-stacked');
    });

    it('restacks after a resize in a task of its own, never inside the resize callback', () => {
      const tile = renderTile();

      textTrack(60);
      resizeTile(tile);

      expect(tile).not.toHaveAttribute('data-stacked');
    });

    it('drops a restack still waiting for its task once unmounted', () => {
      const { unmount } = render(
        <Notice icon={Glyph} data-testid="notice" tone="error" placement="tile" title="Cause." />
      );
      resizeTile(screen.getByTestId('notice'));

      unmount();

      expect(vi.getTimerCount()).toBe(0);
    });

    it('measures again when fonts finish loading', () => {
      const fonts = new EventTarget();
      Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
      const tile = renderTile();

      wordWidth = 140;
      fonts.dispatchEvent(new Event('loadingdone'));

      expect(tile).toHaveAttribute('data-stacked');
    });

    it("measures again when the root's text settings change", async () => {
      const tile = renderTile();

      wordWidth = 140;
      document.documentElement.classList.add('a11y-font-scale-141');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(tile).toHaveAttribute('data-stacked');
    });

    it('unstacks when its words fit again', () => {
      wordWidth = 140;
      const tile = renderTile();

      wordWidth = 90;
      resizeTile(tile);
      vi.runOnlyPendingTimers();

      expect(tile).not.toHaveAttribute('data-stacked');
    });

    it('stops observing the tile once unmounted', () => {
      const { unmount } = render(
        <Notice icon={Glyph} data-testid="notice" tone="error" placement="tile" title="Cause." />
      );
      const observer = tileObserver(screen.getByTestId('notice'));

      unmount();

      expect(observer.disconnected).toBe(true);
    });

    it('stops listening for fonts once unmounted', () => {
      const fonts = new EventTarget();
      const removed = vi.spyOn(fonts, 'removeEventListener');
      Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
      const { unmount } = render(
        <Notice icon={Glyph} tone="error" placement="tile" title="Cause." />
      );

      unmount();

      expect(removed).toHaveBeenCalledWith('loadingdone', expect.any(Function));
    });
  });
});
