import { Button, Input, Logo } from '@hushbox/ui';

import { clockAt } from './timeline.js';

import type { CSSProperties } from 'react';
import type { UiProps } from '../../look/index.js';

const MESSAGE = 'Which model writes the best tests?';
/** The frame the first character is typed, and the frames each one takes. */
const TYPE_FROM = 20;
const FRAMES_PER_CHARACTER = 2;
/** The app's CSS pixels to one frame pixel inside the panel. */
const PANEL_SCALE = 2.5;
const PANEL_WIDTH = 340;

/** The characters typed by a clock reading. */
function typedAt(clock: number): string {
  const count = Math.floor((clock - TYPE_FROM) / FRAMES_PER_CHARACTER);
  return MESSAGE.slice(0, Math.max(0, Math.min(MESSAGE.length, count)));
}

/** How one element swings: its period in frames, its reach in CSS pixels, its turn in degrees. */
interface Swing {
  period: number;
  x: number;
  y: number;
  turn: number;
}

/** The transform that swings one element at a clock reading. */
function swing(clock: number, { period, x, y, turn }: Swing): CSSProperties {
  const phase = (clock / period) * Math.PI * 2;
  return {
    transform: `translate(${String(x * Math.sin(phase))}px, ${String(y * Math.cos(phase))}px) rotate(${String(turn * Math.sin(phase))}deg)`,
  };
}

/**
 * A panel of the app's own components drawn from the frame: the logo, a
 * labelled message field typed into one character every two frames, and the
 * send button, each moved by its own transform.
 * @toolContract
 */
export function Ui({ frame }: Readonly<UiProps>): React.JSX.Element {
  const clock = clockAt(frame);
  const panel: CSSProperties = {
    position: 'absolute',
    left: 115,
    top: 520,
    width: PANEL_WIDTH,
    padding: 20,
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    borderRadius: 20,
    background: 'var(--background-paper)',
    transformOrigin: 'top left',
    transform: `scale(${String(PANEL_SCALE)}) rotate(${String(4 * Math.sin((clock / 150) * Math.PI * 2))}deg)`,
  };
  return (
    <div style={panel}>
      <div style={swing(clock, { period: 90, x: 12, y: 6, turn: 6 })}>
        <Logo />
      </div>
      <div style={swing(clock, { period: 120, x: 8, y: 0, turn: 0 })}>
        <Input label="Message" value={typedAt(clock)} readOnly />
      </div>
      <div style={swing(clock, { period: 60, x: 0, y: 4, turn: 3 })}>
        <Button>Send</Button>
      </div>
    </div>
  );
}
