// @ts-check

/**
 * The API's shared library directories (`apps/api/src/lib/*`).
 * @type {string[]}
 */
export const apiLibraryDirectories = [
  'cache-policy',
  'context',
  'errors',
  'idempotency',
  'jobs',
  'pagination',
  'rate-limit',
  'redis',
  'resilience',
  'result',
  'telemetry',
];

/**
 * Brace group naming those directories, for use inside a lint `files` glob.
 *
 * The directories are enumerated rather than matched with a bare
 * `**\/src/lib/**` because these globs resolve against each consuming package's
 * base path, so the wildcard form would also capture unrelated trees such as
 * the web app's `apps/web/src/lib`. Every config that needs the API's lib layout builds
 * its glob from this one value — a second list would be a copy that drifts.
 *
 * @type {string}
 */
export const apiLibraryDirectoriesGlobGroup = `{${apiLibraryDirectories.join(',')}}`;
