import * as React from 'react';
import { COLORBLIND_MATRICES } from './colorblind-matrices';

/**
 * SvgColorblindDefs — injects the SVG <defs> with feColorMatrix filters used by colorblind CSS rules.
 * Mount once at the app root. The element is invisible (zero width/height, position absolute).
 * CSS rules in colorblind.css reference these by id (e.g. filter: url(#a11y-cb-protan)).
 */
export function SvgColorblindDefs(): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      style={{ position: 'absolute', width: 0, height: 0, pointerEvents: 'none' }}
    >
      <defs>
        {Object.entries(COLORBLIND_MATRICES).map(([key, values]) => (
          <filter key={key} id={`a11y-cb-${key}`}>
            <feColorMatrix values={values} />
          </filter>
        ))}
      </defs>
    </svg>
  );
}
