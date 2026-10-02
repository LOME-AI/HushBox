import { useState } from 'react';
import { AbsoluteFill, Html5Audio, staticFile, useCurrentFrame, useDelayRender } from 'remotion';

import { masterAudioPath } from '../../render/master-audio.js';
import { WIDTH } from '../../time/grid.js';
import { definition } from './film.js';
import { FLASH, GROUND, MARK, SWEEP } from './palette.js';

/**
 * Studio reaches every composition through the bundler context in the package
 * root, so no module imports these exports.
 * @toolContract
 */
export { definition } from './film.js';

/** Bits of the frame-number bar code: enough for 4,096 frames. */
const CODE_BITS = 12;
const CELL_PX = 72;
const CELL_GAP_PX = 12;
const SWEEP_PX = 24;

const { spec } = definition;
const FLASH_FRAMES = new Set(spec.cues.map((cue) => cue.from));

/** The input props: `stallAt` names a frame that never finishes rendering, the stall timeout's control. */
interface RenderFixtureProps {
  stallAt?: number;
}

/** Holds its frame open for good: a render stall on demand. */
function Stall(): null {
  const { delayRender } = useDelayRender();
  useState(() => delayRender('engine-render: the stall control holds this frame open'));
  return null;
}

/** The frame number in binary, most significant bit first, as a row of cells. */
function BarCode({ frame, ink }: Readonly<{ frame: number; ink: string }>): React.JSX.Element {
  const bits = Array.from(
    { length: CODE_BITS },
    (_, index) => Math.floor(frame / 2 ** (CODE_BITS - 1 - index)) % 2 === 1
  );
  return (
    <AbsoluteFill style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center' }}>
      {bits.map((set, index) => (
        <div
          key={index}
          style={{
            width: CELL_PX,
            height: CELL_PX,
            marginLeft: index === 0 ? 0 : CELL_GAP_PX,
            boxShadow: `inset 0 0 0 4px ${ink}`,
            backgroundColor: set ? ink : 'transparent',
          }}
        />
      ))}
    </AbsoluteFill>
  );
}

/**
 * Each beat's frame flashes white; between beats the frame is dark, with a bar
 * sweeping across it over the beat. Every frame carries its own number as a bar
 * code, so a decoded frame names the frame it shows. The master plays from
 * frame 0 in Studio preview.
 * @toolContract
 */
export function Component({ stallAt }: Readonly<RenderFixtureProps>): React.JSX.Element {
  const frame = useCurrentFrame();
  const flash = FLASH_FRAMES.has(frame);
  const ink = flash ? GROUND : MARK;
  const phase = (frame % spec.grid.framesPerBeat) / spec.grid.framesPerBeat;
  return (
    <AbsoluteFill style={{ backgroundColor: flash ? FLASH : GROUND }}>
      <Html5Audio src={staticFile(masterAudioPath(spec.id))} />
      <div
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: phase * (WIDTH - SWEEP_PX),
          width: SWEEP_PX,
          backgroundColor: flash ? GROUND : SWEEP,
        }}
      />
      <BarCode frame={frame} ink={ink} />
      {frame === stallAt ? <Stall /> : null}
    </AbsoluteFill>
  );
}
