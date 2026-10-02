import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import {
  ArrowLeft as LucideArrowLeft,
  ArrowRight as LucideArrowRight,
  ChevronsDown as LucideChevronsDown,
  ChevronsUp as LucideChevronsUp,
  ChevronsUpDown as LucideChevronsUpDown,
  Circle as LucideCircle,
  CircleAlert as LucideCircleAlert,
  CircleCheck as LucideCircleCheck,
  CircleX as LucideCircleX,
  Clock as LucideClock,
  Ellipsis as LucideEllipsis,
  Eraser as LucideEraser,
  File as LucideFile,
  FingerprintPattern as LucideFingerprintPattern,
  Gauge as LucideGauge,
  HatGlasses as LucideHatGlasses,
  Hourglass as LucideHourglass,
  Lock as LucideLock,
  MailCheck as LucideMailCheck,
  RotateCw as LucideRotateCw,
} from 'lucide-react';
import {
  ArrowLeft,
  ArrowRight,
  ChevronsDown,
  ChevronsUp,
  ChevronsUpDown,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  Ellipsis,
  Eraser,
  File,
  Fingerprint,
  Gauge,
  GitHubMark,
  HatGlasses,
  HelcimMark,
  Hourglass,
  Icon,
  Lock,
  MailCheck,
  RotateCw,
  ScrollChevron,
} from '@hushbox/ui/icons';

describe('@hushbox/ui/icons', () => {
  it('re-exports lucide icons under their own names', () => {
    expect(Lock).toBe(LucideLock);
  });

  it.each([
    ['RotateCw', RotateCw, LucideRotateCw],
    ['Circle', Circle, LucideCircle],
    ['CircleCheck', CircleCheck, LucideCircleCheck],
  ])('re-exports the roadmap status glyph %s', (_name, doorIcon, lucideIcon) => {
    expect(doorIcon).toBe(lucideIcon);
  });

  it.each([
    ['Fingerprint', Fingerprint, LucideFingerprintPattern],
    ['Eraser', Eraser, LucideEraser],
    ['HatGlasses', HatGlasses, LucideHatGlasses],
  ])('re-exports the trust glyph %s', (_name, doorIcon, lucideIcon) => {
    expect(doorIcon).toBe(lucideIcon);
  });

  it('re-exports the arrow between what is typed and what is stored', () => {
    expect(ArrowRight).toBe(LucideArrowRight);
  });

  it('re-exports the glyph of a no answer', () => {
    expect(CircleX).toBe(LucideCircleX);
  });

  it('re-exports the glyph of an expired link', () => {
    expect(Clock).toBe(LucideClock);
  });

  it('re-exports the horizontal ellipsis of a row options button', () => {
    expect(Ellipsis).toBe(LucideEllipsis);
  });

  it('re-exports the glyph of the newsletter sent state', () => {
    expect(MailCheck).toBe(LucideMailCheck);
  });

  it.each([
    ['ChevronsDown', ChevronsDown, LucideChevronsDown],
    ['ChevronsUp', ChevronsUp, LucideChevronsUp],
  ])('re-exports the show-or-hide-all glyph %s', (_name, doorIcon, lucideIcon) => {
    expect(doorIcon).toBe(lucideIcon);
  });

  it('re-exports the reasoning-effort gauge', () => {
    expect(Gauge).toBe(LucideGauge);
  });

  it('re-exports the account menu glyph', () => {
    expect(ChevronsUpDown).toBe(LucideChevronsUpDown);
  });

  it.each([
    ['File', File, LucideFile],
    ['ArrowLeft', ArrowLeft, LucideArrowLeft],
  ])('re-exports the account-deletion glyph %s', (_name, doorIcon, lucideIcon) => {
    expect(doorIcon).toBe(lucideIcon);
  });

  it.each([
    ['CircleAlert', CircleAlert, LucideCircleAlert],
    ['Hourglass', Hourglass, LucideHourglass],
  ])('re-exports the notice severity glyph %s', (_name, doorIcon, lucideIcon) => {
    expect(doorIcon).toBe(lucideIcon);
  });

  it('draws a re-exported icon through Icon', () => {
    const { container } = render(<Icon icon={Lock} size="sm" />);

    expect(container.querySelector('svg')).toHaveClass('size-3.5');
  });

  it.each([
    ['GitHubMark', GitHubMark],
    ['HelcimMark', HelcimMark],
    ['ScrollChevron', ScrollChevron],
  ])('draws the %s mark through Icon', (_name, mark) => {
    const { container } = render(<Icon icon={mark} />);

    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});
