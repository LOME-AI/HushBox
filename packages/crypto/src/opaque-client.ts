import {
  OpaqueClient,
  getOpaqueConfig,
  OpaqueID,
  RegistrationResponse,
  KE2,
} from '@cloudflare/opaque-ts';

export const OpaqueClientConfig = getOpaqueConfig(OpaqueID.OPAQUE_P256);

export function createOpaqueClient(): OpaqueClient {
  return new OpaqueClient(OpaqueClientConfig);
}

// Registration
export interface RegistrationRequest {
  serialized: number[];
}

export async function startRegistration(
  client: OpaqueClient,
  password: string
): Promise<RegistrationRequest> {
  const result = await client.registerInit(password);
  if (result instanceof Error) {
    throw result;
  }
  return {
    serialized: result.serialize(),
  };
}

export interface RegistrationResult {
  record: number[];
  exportKey: number[];
}

export async function finishRegistration(
  client: OpaqueClient,
  serverResponse: number[],
  serverIdentifier?: string
): Promise<RegistrationResult> {
  const response = RegistrationResponse.deserialize(OpaqueClientConfig, serverResponse);
  const result = await client.registerFinish(response, serverIdentifier);
  if (result instanceof Error) {
    throw result;
  }
  return {
    record: result.record.serialize(),
    exportKey: result.export_key,
  };
}

// Login
export interface LoginRequest {
  ke1: number[];
}

export async function startLogin(client: OpaqueClient, password: string): Promise<LoginRequest> {
  const result = await client.authInit(password);
  if (result instanceof Error) {
    throw result;
  }
  return {
    ke1: result.serialize(),
  };
}

export interface LoginResult {
  ke3: number[];
  sessionKey: number[];
  exportKey: number[];
}

export async function finishLogin(
  client: OpaqueClient,
  ke2: number[],
  serverIdentifier?: string
): Promise<LoginResult> {
  const ke2Object = KE2.deserialize(OpaqueClientConfig, ke2);
  const result = await client.authFinish(ke2Object, serverIdentifier);
  if (result instanceof Error) {
    throw result;
  }
  return {
    ke3: result.ke3.serialize(),
    sessionKey: result.session_key,
    exportKey: result.export_key,
  };
}

// Re-export value (needed for .deserialize() in seed scripts)

// Re-export types for convenience

export {
  RegistrationRequest as OpaqueRegistrationRequest,
  type RegistrationRecord as OpaqueRegistrationRecord,
  type KE3,
  type KE1,
  type OpaqueClient,
  type KE2,
  type RegistrationResponse,
} from '@cloudflare/opaque-ts';
