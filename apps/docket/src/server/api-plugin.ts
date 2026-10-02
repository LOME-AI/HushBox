import { inspect } from 'node:util';
import { createAuditService } from './audit-service.ts';
import { createEventHub } from './events.ts';
import { startIdleTimer } from './idle-timer.ts';
import { parseLaunchOptions } from './launch-options.ts';
import { createRouter, isEventStream, sendInternalError } from './routes.ts';
import { installSignalShutdown } from './shutdown.ts';
import type { IdleTimer, IdleTimerOptions } from './idle-timer.ts';
import type { ApiRequest } from './routes.ts';
import type { ResponseLike } from './http.ts';
import type { SignalShutdownOptions } from './shutdown.ts';
import type { Plugin } from 'vite';

interface ApiPluginOptions {
  readonly repoRoot: string;
  /** Launch flags; defaults to this process's own. */
  readonly argv?: readonly string[];
  readonly log?: (message: string) => void;
  readonly exit?: (code: number) => void;
  readonly startTimer?: (options: IdleTimerOptions) => IdleTimer;
  readonly installShutdown?: (options: SignalShutdownOptions) => () => void;
}

/** A real `ServerResponse` reports whether its status line has gone out. */
interface AnswerableResponse extends ResponseLike {
  readonly headersSent?: boolean;
}

function writeLine(message: string): void {
  process.stdout.write(`${message}\n`);
}

/**
 * Mounts the console's API on the Vite dev server (`configureServer` runs only
 * under `vite serve`, so this ships nowhere) and holds the two pieces of
 * process state the console needs: the idle window and the signal shutdown.
 * Audit directories are watched by the hub, one per audit a stream is open on.
 */
export function docketApiPlugin(options: ApiPluginOptions): Plugin {
  const log = options.log ?? writeLine;
  const exit = options.exit ?? process.exit.bind(process);
  const startTimer = options.startTimer ?? startIdleTimer;
  const installShutdown = options.installShutdown ?? installSignalShutdown;

  return {
    name: 'hushbox:docket-api',
    // The launch flags are read here, not while the plugin is being built:
    // tooling loads `vite.config.ts` inside its own process (knip does, with
    // its own `--no-progress` on the command line), and only a real
    // `vite serve` reaches this hook, where the argv is the launcher's own.
    async configureServer(server) {
      const launch = parseLaunchOptions(options.argv ?? process.argv.slice(2));
      const service = createAuditService({
        repoRoot: options.repoRoot,
        defaultAudit: launch.audit,
      });

      // The routes admit an audit name by membership in this same set, so a
      // launch default outside it would come up as a server that 404s everything.
      const served = await service.auditNames();
      if (launch.audit !== null && !served.includes(launch.audit)) {
        const alternatives = served.length === 0 ? 'no audits at all' : served.join(', ');
        log(
          `docket: --audit "${launch.audit}" is not an audit this console serves; it serves ${alternatives}`
        );
        exit(1);
        return;
      }

      const events = createEventHub();
      const router = createRouter({ service, events });

      let timer: IdleTimer | null = null;
      if (launch.idleMinutes !== null) {
        const minutes = launch.idleMinutes;
        timer = startTimer({
          minutes,
          onExpire: async () => {
            log(`docket: idle for ${String(minutes)} minutes, shutting down`);
            await server.close();
            exit(0);
          },
        });
      }

      const stopSignals = installShutdown({
        close: () => server.close(),
        log,
        forceExit: exit,
      });

      server.middlewares.use((req, res, next) => {
        const request: ApiRequest = req;
        if (request.url?.startsWith('/api/') === true && !isEventStream(request.url))
          timer?.touch();

        // Nothing awaits this, so an escaping throw is an unhandled rejection
        // and Node ends the process: the reader loses the console mid-session
        // and every undo token it holds in memory with it.
        void (async (): Promise<void> => {
          const answerable: AnswerableResponse = res;
          try {
            const handled = await router.handle(request, answerable);
            if (!handled) next();
          } catch (error) {
            const label = `${request.method ?? 'GET'} ${String(request.url)}`;
            log(`docket: ${label} failed\n${inspect(error)}`);
            try {
              // A response already on the wire, an event stream above all,
              // cannot take a status line.
              if (answerable.headersSent !== true) sendInternalError(answerable);
            } catch (error_) {
              // Saying so must not itself become the unhandled rejection this
              // catch exists to prevent, so a dead socket ends here.
              log(`docket: ${label} could not be answered\n${inspect(error_)}`);
            }
          }
        })();
      });

      server.httpServer?.on('close', () => {
        timer?.stop();
        stopSignals();
      });
    },
  };
}
