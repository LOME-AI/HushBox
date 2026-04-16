/**
 * Object storage abstraction for encrypted media.
 *
 * Writes/deletes go through Cloudflare's R2 Workers binding (no credentials needed).
 * Reads are done by clients via short-lived presigned GET URLs minted via
 * the S3 API using the R2 S3 credentials — bytes flow direct R2 → browser
 * without passing through the Worker.
 *
 * There is intentionally NO mintUploadUrl. Presigned PUT URLs are a security
 * anti-pattern; all writes originate inside the Worker.
 */
export interface MediaStorage {
  /** Whether this is a mock (test) implementation. */
  readonly isMock: boolean;

  /**
   * Store encrypted bytes at the given key.
   * Called from strategies after encrypting media under a message's content key.
   * @throws StorageWriteError on upstream failure.
   */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;

  /**
   * Mint a short-lived presigned GET URL for reading the object at `key`.
   * The URL is signed with the R2 S3 credentials and expires after the
   * configured TTL (default MEDIA_DOWNLOAD_URL_TTL_SECONDS).
   *
   * `expiresAt` is an ISO-8601 timestamp — the client uses it to decide
   * when to re-mint before the URL expires.
   *
   * @throws StorageReadError on signing/backing-store failure.
   */
  mintDownloadUrl(params: {
    key: string;
    expiresInSec?: number;
  }): Promise<{ url: string; expiresAt: string }>;

  /**
   * Delete the object at `key`. Idempotent — succeeds if the key doesn't exist.
   * @throws StorageWriteError on upstream failure.
   */
  delete(key: string): Promise<void>;
}

/**
 * In-memory MediaStorage used in unit/integration tests.
 * Exposes test helpers that the real storage does not.
 */
export interface MockMediaStorage extends MediaStorage {
  readonly isMock: true;
  /** Return the stored bytes for a key, or undefined if missing. */
  getObject(key: string): { bytes: Uint8Array; contentType: string } | undefined;
  /** Remove all stored objects. */
  clearAll(): void;
  /** List all currently stored keys in insertion order. */
  listKeys(): string[];
}

/**
 * Thrown when a storage write (`put` or `delete`) fails upstream.
 * The cause is the underlying error from the R2 binding, preserved for logging.
 */
export class StorageWriteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StorageWriteError';
  }
}

/**
 * Thrown when a presigned URL cannot be minted or a storage read fails.
 */
export class StorageReadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StorageReadError';
  }
}
