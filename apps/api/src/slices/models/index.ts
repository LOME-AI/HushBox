export {
  buildSmartModelCandidates,
  buildTrialSmartModelCandidates,
  createCatalogRefreshEntry,
  createEstimateRun,
  createModelPricingResolver,
  createToolRegistry,
  DESCRIPTOR_VERSION,
  estimateRunCeilingNanoUsd,
  findAdminDisabledModel,
  findTierLockedModel,
  listAdminCatalog,
  listDescriptors,
  mediaTurnMinCostNanoUsd,
  modelDisplayOf,
  pickEffortClassifier,
  priceMediaBillableNanoUsd,
  priceUsageBillableNanoUsd,
  productionRefreshJitter,
  refreshCatalog,
  resolveToolRegistry,
  smartModelMinimumNanoUsd,
  snapshotResolver,
  TRIAL_MESSAGE_COST_CAP_NANO_USD,
  trialEligibility,
  trialMessageBillableNanoUsd,
  upsertCatalog,
} from './domain/index.js';
export { WEB_SEARCH_TOOL_NAME } from '@hushbox/shared';
export { createModelsManifest } from './routes.js';
export { MODELS_ROUTE_POSTURES } from './rate-limit-posture.js';
export { catalogListIpRateLimit } from './domain/rate-limit.js';
export type {
  AdminCatalogModel,
  ListDescriptorsDeps,
  ModelPricingResolver,
  RefreshJitter,
  RefreshSummary,
  SmartModelCandidateEntry,
  SmartModelCandidates,
  UpsertCatalogParams,
} from './domain/index.js';
export { resolveModelProvider } from './adapters/resolve-model-provider.js';
export { resolveSearchProvider } from './adapters/resolve-search-provider.js';
export {
  MOCK_ECHO_AFFIXES,
  MOCK_GENERATION_COST_USD,
  mockProviderEnabled,
  parseMockDirectives,
} from './adapters/mock-provider.js';
export { createCatalogSightingRecorder } from './adapters/catalog-lifecycle.js';
export { disableModelWithinTx, enableModelWithinTx } from './adapters/catalog-admin.js';
export { OPENROUTER_BASE_URL } from './adapters/openrouter-provider.js';
export { InferenceError } from './adapters/inference-error.js';
export type { InferenceErrorCode } from './adapters/inference-error.js';
export type { ObservedTokenUsage } from './domain/pricing/estimate.js';
export type { InferOptions, ModelProvider, ToolLoopOptions, ToolRegistry } from './ports/index.js';
