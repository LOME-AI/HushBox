import type { Model } from '../schemas/api/models.js';
import { CAPABILITIES, type CapabilityId } from './types.js';

export function getModelCapabilities(model: Model): CapabilityId[] {
  const supportedParams = new Set(model.supportedParameters);

  return Object.values(CAPABILITIES)
    .filter((cap) => cap.requiredParameters.every((p) => supportedParams.has(p)))
    .map((cap) => cap.id);
}

export function modelSupportsCapability(model: Model, capabilityId: CapabilityId): boolean {
  const cap = CAPABILITIES[capabilityId];
  const supportedParams = new Set(model.supportedParameters);
  return cap.requiredParameters.every((p) => supportedParams.has(p));
}
