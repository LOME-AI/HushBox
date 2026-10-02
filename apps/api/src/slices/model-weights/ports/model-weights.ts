/**
 * The minimal structural slice of the `MODEL_WEIGHTS` R2 bucket binding the
 * artifact route consumes. Structural (not the global `R2Bucket` type) so
 * integration tests can back it with MinIO through the same shape.
 */
export interface ModelWeightsBucket {
  get(key: string): Promise<{ readonly body: ReadableStream | null; readonly size: number } | null>;
}
