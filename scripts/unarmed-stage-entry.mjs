/**
 * Starts one command with the raw process library — attached, inheriting this
 * process's streams, and handing it nothing else.
 *
 * It is the negative control for the lifeline the chain hands its stages: the
 * same tree, under a starter that arms nothing, must survive that starter's
 * hard kill. Without it a case watching the armed tree go away cannot say
 * whether the lifeline was what took it, or whether the tree would have gone
 * anyway.
 *
 * An ES module rather than TypeScript because it never runs inside the vitest
 * process, so its lines are nobody's coverage.
 *
 * Spawned as `node <this file> <command> [...args]`.
 */
import { execa } from 'execa';

const [file, ...args] = process.argv.slice(2);

const environment = { ...process.env };
// Removed rather than emptied. An address that is present and empty is a
// spawner that handed one over and lost it, which the mechanism refuses to run
// on; this control is a chain that was never given one at all.
delete environment['HB_SPAWN_LIFELINE'];

await execa(file, args, { stdio: 'inherit', env: environment, reject: false });
