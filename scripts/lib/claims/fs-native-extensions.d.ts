/**
 * `fs-native-extensions` ships no types. Only the three entry points the claim
 * primitive uses are declared; the package's remaining surface (sparse files,
 * extended attributes, path swapping) is deliberately absent so an accidental
 * reach for it is a compile error rather than a silent new dependency edge.
 *
 * The lock is advisory and owned by the open file description, not by the
 * process: `F_OFD_SETLK` on Linux, `flock(2)` on macOS, `LockFileEx` on Windows.
 */
declare module 'fs-native-extensions' {
  interface LockOptions {
    /** A read lock rather than the default write lock. */
    readonly shared?: boolean;
  }

  /** `true` when the lock was granted, `false` when another descriptor holds it. */
  export function tryLock(
    fd: number,
    offset?: number,
    length?: number,
    options?: LockOptions
  ): boolean;

  /** Resolves when the lock is granted. Waits off the event loop, never on it. */
  export function waitForLock(
    fd: number,
    offset?: number,
    length?: number,
    options?: LockOptions
  ): Promise<void>;

  export function unlock(fd: number, offset?: number, length?: number): void;
}
