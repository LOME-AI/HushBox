/**
 * A long-lived child that holds nothing, does nothing, and ends when the
 * process that started it does.
 *
 * It is what a case needs whenever the subject is a tree rather than what the
 * tree is doing: a process that stays until something ends it, binding no port
 * so that nothing working from ports can be what ended it. The command it
 * replaces — an interval written on the runner's own command line — was that
 * process without the last property, and a run killed mid-file left one of them
 * standing on the machine for good. Nothing named it, no port reached it, and
 * the only thing that ever removed one was a person.
 *
 * So it watches its spawner over the same connection every child of this
 * repository that runs the spawner's own module watches: the address in the
 * environment, and the end-of-file the kernel delivers when the process
 * answering there goes, whatever took it. That is what makes this child's
 * lifetime the run's own rather than the machine's.
 *
 * Started with no spawner to watch it refuses rather than running on: a fixture
 * that outlives the run which started it is the defect this exists to remove,
 * and one that ran unwatched would reintroduce it silently.
 *
 * `--deaf` makes it ignore being asked to stop, for a case whose subject is
 * what happens to a tree that did not take the hint.
 *
 * An ES module rather than TypeScript because it never runs inside the vitest
 * process, so its lines are nobody's coverage. It imports the spawner's module,
 * so it is started as `node --import tsx <this file> [--deaf]`.
 */
import { connectLifeline, watchSpawner } from './long-lived.ts';

/** What it exits with once its spawner has gone: the work it stood for did not finish. */
const SPAWNER_GONE_EXIT_CODE = 1;

// Keeps it running until something ends it, which is the whole of what it does.
const staying = setInterval(() => process.stdout.write(''), 60_000);

const watched = watchSpawner(process.env, connectLifeline, () => {
  // Named rather than forced: the connection this ran off is unrefed and the
  // interval was the only thing holding the loop open, so letting go of it is
  // what ends this process, with the code it was let go of for.
  clearInterval(staying);
  process.exitCode = SPAWNER_GONE_EXIT_CODE;
});

if (!watched) {
  throw new Error(
    'This child was started with no spawner to watch, so nothing would end it when the run ' +
      'that started it goes. Start it through the spawner, which is what publishes the address.'
  );
}

if (process.argv.includes('--deaf')) {
  // Answered with nothing, which is what makes it deaf: listening for a
  // terminating signal is what suppresses the default action it carries.
  process.on('SIGTERM', () => process.stdout.write(''));
}
