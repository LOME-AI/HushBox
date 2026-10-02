import * as React from 'react';

type NoticePlacement = 'inline' | 'composer' | 'tile' | 'slot';

const NoticePlacementContext = React.createContext<NoticePlacement>('inline');

/** Where the enclosing notice sits, so its corner control can take that placement's size. */
function useNoticePlacement(): NoticePlacement {
  return React.useContext(NoticePlacementContext);
}

export { NoticePlacementContext, useNoticePlacement, type NoticePlacement };
