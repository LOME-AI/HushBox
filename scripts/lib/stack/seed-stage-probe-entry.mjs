/**
 * Stands in for the seed module inside the end-to-end chain's seed stage, so a
 * suite can watch which stack's database that stage's write lands in.
 *
 * It keeps the seed's shape and none of its content: one connection on the
 * `DATABASE_URL` the stage resolved, one table of the caller's naming, rows
 * written into it, and nothing else read or changed. The stack's own seeded
 * state is never touched, which is what lets this run against a stack a
 * developer or a concurrent run may be holding; dropping the table is the
 * caller's, because the caller is what reads it first.
 *
 * Written as an ES module rather than TypeScript because it never runs inside
 * the vitest process, so its lines are not the scripts' coverage.
 *
 * Spawned by replacing the seed module's token in the stage the root manifest
 * declares, with the table to write as its only argument.
 */
import { createTestDbExecutor } from '../test-run/test-db-provision.ts';

/** What a table this writes into may be called, so its name reaches SQL unquoted. */
const TABLE_NAME = /^[a-z][\da-z_]*$/;

const [table] = process.argv.slice(2);
if (table === undefined || !TABLE_NAME.test(table)) {
  throw new Error('seed-stage probe: its one argument is the table to write, in lower snake case');
}

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === '') {
  throw new Error('seed-stage probe: the stage resolved no DATABASE_URL, so it addresses no stack');
}

const executor = createTestDbExecutor(connectionString);
try {
  await executor.exec(`CREATE TABLE ${table} (id integer PRIMARY KEY)`);
  await executor.exec(`INSERT INTO ${table} (id) VALUES (1), (2)`);
} finally {
  await executor.close();
}
