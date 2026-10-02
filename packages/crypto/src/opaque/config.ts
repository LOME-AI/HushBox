import { getOpaqueConfig, OpaqueID } from '@cloudflare/opaque-ts';

export const OpaqueServerConfig = getOpaqueConfig(OpaqueID.OPAQUE_P256);
