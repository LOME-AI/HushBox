/**
 * Holds a TCP port until it is killed, and optionally starts a child that holds
 * a second one. Only a real listener can show that killing a tree frees the
 * address its deepest member was holding, and only a real grandchild can show
 * that a supervisor's child dies with it.
 *
 * The `escape` argument makes that child the leader of its own process group,
 * which is what a task supervisor such as `turbo` does to everything it runs:
 * the group its parent was recorded under then reaches the parent and nothing
 * else, so the port survives the kill that empties the recorded group.
 *
 * `--watch-spawner` arms it against the process that started it, so that a run
 * killed too hard to clean up after takes this listener with it. It is asked
 * for rather than assumed because the two kinds of caller want opposite things:
 * a case that starts this from its own test worker leaves a real listener on a
 * real machine every time that worker is killed, on an ephemeral port outside
 * every band a port reclaimer looks at, while a case whose subject is what a
 * killed run leaves behind needs exactly that survival to assert on. Passing
 * the flag is what separates them, and it travels down to the child this starts
 * so a whole tree is armed or none of it is.
 *
 * Armed with nothing to watch it holds its port and runs on, where the child
 * fixture beside it refuses: one caller starts this from a process that
 * publishes no address at all, and a refusal there would turn a deliberate
 * control into a failure. What that costs is what it cost before there was a
 * flag — a listener the next run reclaims rather than one that ends itself.
 *
 * `--deaf` makes the whole tree ignore every signal it can catch, for a case
 * whose subject is what reaches a tree that did not take the hint. It travels
 * down to the child for the same reason the arming flag does, and the port each
 * process binds is what says the handlers are installed — a tree signalled
 * before that is one the default action ends.
 *
 * An ES module rather than TypeScript because it never runs inside the vitest
 * process, so its lines are nobody's coverage. Armed it imports the spawner's
 * module, so it is started as `node --import tsx <this file> <port>
 * [childPort] [escape] --watch-spawner [--deaf]`; unarmed it needs no loader
 * and is started as `node <this file> <port> [childPort] [escape]`.
 */
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** The opt-in, spelled here and at the call sites that ask for it. */
const WATCH_SPAWNER = '--watch-spawner';

/** The other opt-in, which makes every catchable signal reach a handler that does nothing. */
const DEAF = '--deaf';

/** What it exits with once its spawner has gone: the work it stood for did not finish. */
const SPAWNER_GONE_EXIT_CODE = 1;

const watching = process.argv.includes(WATCH_SPAWNER);
const deaf = process.argv.includes(DEAF);
const [port, childPort, escape] = process.argv
  .slice(2)
  .filter((argument) => argument !== WATCH_SPAWNER && argument !== DEAF);

if (deaf) {
  // Answered with nothing, which is what makes it deaf: listening for a
  // terminating signal is what suppresses the default action it carries.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
    process.on(signal, () => process.stdout.write(''));
}

const child =
  childPort === undefined
    ? undefined
    : spawn(
        process.execPath,
        [
          // This process's own node flags first. Armed they are the loader that
          // makes the import below work, and the child needs it for the same
          // reason; unarmed there are none, so the command line is the one it was.
          ...process.execArgv,
          fileURLToPath(import.meta.url),
          childPort,
          ...(watching ? [WATCH_SPAWNER] : []),
          ...(deaf ? [DEAF] : []),
        ],
        { stdio: 'ignore', detached: escape === 'escape' }
      );

const holding = createServer().listen(Number(port), '127.0.0.1');

if (watching) {
  const { connectLifeline, watchSpawner } = await import('./long-lived.ts');
  // Whether a spawner was found is deliberately not checked, which is the whole
  // of what this file's module docstring calls running on with nothing to watch.
  watchSpawner(process.env, connectLifeline, () => {
    // Let go of rather than forced: the listener and the handle of the child
    // this may have started are the two things holding the loop open, so
    // releasing both is what ends this process, with the code it was released
    // for. The address goes with the process either way.
    process.exitCode = SPAWNER_GONE_EXIT_CODE;
    holding.close();
    holding.unref();
    child?.unref();
  });
}
