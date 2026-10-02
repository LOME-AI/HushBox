import * as React from 'react';

import { buttonStackClass } from './button-group-classes';
import { measureButtonGroups } from './measure-button-groups';

/** Buttons one above another, in markup order, at one shared width. */
function ButtonStack({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  const stackRef = React.useRef<HTMLDivElement>(null);

  React.useLayoutEffect(() => {
    const stack = stackRef.current;
    // A layout effect runs once the ref is attached, so the root is always there.
    /* v8 ignore next */
    if (stack === null) return;
    return measureButtonGroups(stack);
  }, []);

  return (
    <div ref={stackRef} className={buttonStackClass}>
      {children}
    </div>
  );
}

export { ButtonStack };
