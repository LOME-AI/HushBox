import { clientContextFor } from './run-steps.js';
import type { FlowStartRequest } from '@hushbox/shared';
import type { NodeRunContext } from './execution-registry.js';

/**
 * What a node's execution is handed from the run's start request: the id the
 * caller minted for the run, the client context {@link clientContextFor}
 * decides, and the node's file-part mapper when the run resolves one for it.
 */
export function runScopedContextFor(
  request: FlowStartRequest,
  nodeId: string,
  routingOnly: boolean
): Pick<NodeRunContext, 'runId'> &
  Partial<Pick<NodeRunContext, 'history' | 'customInstructions' | 'routingOnly' | 'mapFilePart'>> {
  const mapper = request.mapFilePartFor?.(nodeId);
  return {
    runId: request.runId,
    ...clientContextFor(request, routingOnly),
    ...(mapper === undefined ? {} : { mapFilePart: mapper }),
  };
}
