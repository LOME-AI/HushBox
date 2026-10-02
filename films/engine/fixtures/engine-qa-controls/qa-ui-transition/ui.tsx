import { Input } from '@hushbox/ui';

import type { UiProps } from '../../../look/index.js';

/**
 * A labelled field emptied and filled on alternate frames: each change moves
 * the field's floating label, which the component eases with its own CSS
 * transition, so a page that drew the frame before draws the label part way.
 * @toolContract
 */
export function Ui({ frame }: Readonly<UiProps>): React.JSX.Element {
  return (
    <div
      style={{
        position: 'absolute',
        left: 140,
        top: 800,
        width: 320,
        transform: 'scale(2.5)',
        transformOrigin: 'top left',
      }}
    >
      <Input label="Message" value={frame % 2 === 0 ? '' : 'Hush'} readOnly />
    </div>
  );
}
