/**
 * The minimal structural slice of the `APP_BUILDS` R2 bucket binding the
 * download route consumes. Structural (not the global `R2Bucket` type) so
 * integration tests can back it with MinIO through the same shape.
 */
export interface AppBuildsBucket {
  get(key: string): Promise<{ readonly body: ReadableStream | null; readonly size: number } | null>;
}
