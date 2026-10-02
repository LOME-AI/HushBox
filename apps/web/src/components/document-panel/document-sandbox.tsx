import * as React from 'react';
import { Button, Img, cn } from '@hushbox/ui';
import {
  DOCUMENT_IFRAME_SANDBOX_ATTR,
  parseFrameToParentMessage,
  type RunnableDocumentKind,
  type ConsoleMessage,
  type FrameToParentMessage,
  type ParentToFrameMessage,
  type ResultOutput,
  type DocumentErrorCode,
  type LoadingPhase,
} from '@hushbox/shared/documents';
import { sandboxPageUrl } from '../../lib/platform/sandbox-origin';
import { useFrameAppearance } from './frame-appearance';
import { HighlightedSource } from './highlighted-source';
import { DocumentRenderStatus, PENDING_PREVIEW_TEXT } from './document-render-status';
import type { DocumentRenderStatusValue } from './document-render-status';

interface DocumentSandboxProps {
  kind: RunnableDocumentKind;
  code: string;
  title: string;
  /** Whether the message carrying this document is still being written. */
  isStreaming: boolean;
  /** Stands in for the frame while a streaming document has yet to render once. */
  pendingView: React.ReactNode;
}

/**
 * How many console lines the panel keeps. The strip stands five lines tall and
 * offers no search, so output past this bound is not reachable by reading it;
 * the bound is what keeps a document logging in a loop from growing the app's
 * memory without limit, every line costing a copy of the array it lands in.
 */
export const CONSOLE_LINE_CAP = 200;

interface ConsoleLine {
  id: number;
  stream: 'stdout' | 'stderr';
  text: string;
}

interface SandboxState {
  status: DocumentRenderStatusValue;
  phase: LoadingPhase | null;
  consoleLines: ConsoleLine[];
  outputs: ResultOutput[];
  errorCode: DocumentErrorCode | null;
  /** Whether any attempt has ever painted, which is what a newer one may replace. */
  hasRendered: boolean;
  /**
   * Whether the attempt in flight is the one that painted what is on screen. A
   * react document can report a failure after its render succeeded — React tears
   * the tree down when a later commit round throws — and that is the difference
   * between a failure that killed the live preview and one from an attempt that
   * never painted, which leaves the last good picture alone.
   */
  currentAttemptRendered: boolean;
  /**
   * The code the frame was last given, which is the code `status` is a verdict
   * about. It lives in state rather than a ref because the difference between it
   * and the current code decides what is rendered.
   */
  initializedCode: string | null;
  /**
   * Whether the panel holds the port the frame transferred, which is the only
   * thing a message to the frame can be sent on. It mirrors `readyRef` into
   * state because a control that offers to send must be rendered from it: a
   * status cannot stand in, since the panel reaches `error` both from a frame
   * that reported a failure over its port and from one that never handed a
   * port over at all.
   */
  ready: boolean;
  frameKey: number;
}

type SandboxAction =
  | { type: 'handshake'; isPython: boolean }
  | { type: 'port-closed' }
  | { type: 'auto-start'; code: string }
  | { type: 'python-start'; code: string }
  | { type: 'stop' }
  | { type: 'boot-timeout' }
  | { type: 'frame'; message: FrameToParentMessage; isPython: boolean };

const INITIAL_STATE: SandboxState = {
  status: 'booting',
  phase: null,
  consoleLines: [],
  outputs: [],
  errorCode: null,
  hasRendered: false,
  currentAttemptRendered: false,
  initializedCode: null,
  ready: false,
  frameKey: 0,
};

/**
 * What is on screen while an attempt is in flight. A render already painted is
 * never blanked for a newer attempt — the frame holds the last good picture
 * until that attempt paints or fails, so a document that keeps growing does not
 * flash between a preview and a spinner.
 */
function statusWhileWorking(
  state: SandboxState,
  working: DocumentRenderStatusValue
): DocumentRenderStatusValue {
  return state.hasRendered ? 'rendered' : working;
}

/** Append a console line, dropping the oldest once the buffer is full. */
function appendConsoleLine(lines: ConsoleLine[], message: ConsoleMessage): ConsoleLine[] {
  // The id counts from the line before rather than the array length: a full
  // buffer drops its oldest line for every arrival, so the length stops moving
  // and would hand React the same key twice.
  const id = (lines.at(-1)?.id ?? -1) + 1;
  const kept = lines.length < CONSOLE_LINE_CAP ? lines : lines.slice(1);
  return [...kept, { id, stream: message.stream, text: message.text }];
}

function applyFrameMessage(
  state: SandboxState,
  message: FrameToParentMessage,
  isPython: boolean
): SandboxState {
  switch (message.type) {
    case 'loading': {
      return {
        ...state,
        phase: message.phase,
        status: isPython ? 'running' : statusWhileWorking(state, 'loading'),
      };
    }
    case 'rendered': {
      return {
        ...state,
        phase: null,
        errorCode: null,
        status: 'rendered',
        hasRendered: true,
        currentAttemptRendered: true,
      };
    }
    case 'console': {
      return { ...state, consoleLines: appendConsoleLine(state.consoleLines, message) };
    }
    case 'result': {
      return { ...state, outputs: message.outputs, phase: null, status: 'complete' };
    }
    case 'error': {
      // A failure naming the attempt that painted means that preview is gone —
      // there is no last good picture left to fall back to while the message
      // finishes. A failure from an attempt that never painted changes nothing
      // about the render still on screen.
      return {
        ...state,
        errorCode: message.code,
        phase: null,
        status: 'error',
        hasRendered: state.currentAttemptRendered ? false : state.hasRendered,
        currentAttemptRendered: false,
      };
    }
    /* v8 ignore next 3 -- 'ready' is handled before dispatch and never reaches the reducer */
    case 'ready': {
      return state;
    }
  }
}

function sandboxReducer(state: SandboxState, action: SandboxAction): SandboxState {
  switch (action.type) {
    case 'handshake': {
      // Python stops here and waits for the reader. Every other kind is driven
      // by the `init` sent in the same breath as this, whose own action says
      // what the panel is doing.
      //
      // The boot budget is a deadline, not a cancel: nothing tears a frame down
      // when it runs out, so a slow origin can still answer afterwards and the
      // failure that deadline recorded is stale the moment it does.
      return {
        ...state,
        ready: true,
        errorCode: null,
        status: action.isPython ? 'idle' : state.status,
      };
    }
    case 'port-closed': {
      return { ...state, ready: false };
    }
    case 'auto-start': {
      return {
        ...state,
        status: statusWhileWorking(state, 'loading'),
        phase: null,
        consoleLines: [],
        errorCode: null,
        currentAttemptRendered: false,
        initializedCode: action.code,
      };
    }
    case 'python-start': {
      return {
        ...state,
        status: 'running',
        phase: null,
        consoleLines: [],
        outputs: [],
        errorCode: null,
        currentAttemptRendered: false,
        initializedCode: action.code,
      };
    }
    case 'stop': {
      // A remount (new frameKey → fresh window) is the kill switch.
      return { ...INITIAL_STATE, frameKey: state.frameKey + 1 };
    }
    case 'boot-timeout': {
      return { ...state, status: 'error', errorCode: 'frame_unavailable', phase: null };
    }
    case 'frame': {
      return applyFrameMessage(state, action.message, action.isPython);
    }
  }
}

const LOADING_PHASE_TEXT: Record<LoadingPhase, string> = {
  transpiling: 'Transpiling',
  'loading-modules': 'Loading modules',
  'loading-runtime': 'Loading Python runtime',
  'loading-packages': 'Installing packages',
  executing: 'Executing',
};

// Friendly, content-free copy per closed error code — the machine-readable code
// maps to user text, never the raw author error (that detail rides `message`).
const DOCUMENT_ERROR_TEXT: Record<DocumentErrorCode, string> = {
  transpile_failed: 'This document could not be compiled.',
  import_failed: 'A module import failed.',
  mount_failed: 'The component could not be mounted.',
  runtime_error: 'The document crashed while running.',
  unsupported_kind: 'This document type is not supported.',
  python_error: 'Python raised an error.',
  timed_out: 'This document took too long and was stopped.',
  frame_unavailable: 'The preview could not be loaded.',
  input_unsupported:
    'This program asks for interactive input, which is not available in the preview.',
};

const STATIC_STATUS_TEXT: Record<
  Exclude<DocumentRenderStatusValue, 'loading' | 'running' | 'error'>,
  string
> = {
  booting: 'Loading preview',
  streaming: PENDING_PREVIEW_TEXT,
  idle: 'Ready to run',
  rendered: 'Preview rendered',
  complete: 'Run complete',
};

function statusText(
  status: DocumentRenderStatusValue,
  phase: LoadingPhase | null,
  errorText: string | null
): string {
  if (status === 'loading' || status === 'running') {
    return phase ? LOADING_PHASE_TEXT[phase] : 'Working';
  }
  if (status === 'error') {
    /* v8 ignore next -- every update that moves the status to 'error' sets errorCode in that same update, so errorText is never null here */
    return errorText ?? 'Something went wrong';
  }
  return STATIC_STATUS_TEXT[status];
}

function StatusMirror({
  status,
  phase,
  errorText,
}: Readonly<{
  status: DocumentRenderStatusValue;
  phase: LoadingPhase | null;
  errorText: string | null;
}>): React.JSX.Element {
  return <DocumentRenderStatus status={status} text={statusText(status, phase, errorText)} />;
}

// The visible line and the announced one say the same thing, from one string:
// they describe the same state, and a reader using both at once would otherwise
// hear one wording and read another.
function LoadingLine({ text }: Readonly<{ text: string }>): React.JSX.Element {
  return <div className="text-muted-foreground flex items-center gap-2 text-sm">{text}…</div>;
}

function ErrorCard({ text }: Readonly<{ text: string | null }>): React.JSX.Element | null {
  if (!text) return null;
  return (
    <div
      role="alert"
      className="border-destructive/40 bg-destructive/5 text-destructive rounded-md border p-3 text-sm"
    >
      {text}
    </div>
  );
}

function ConsoleStrip({ lines }: Readonly<{ lines: ConsoleLine[] }>): React.JSX.Element | null {
  if (lines.length === 0) return null;
  return (
    <div
      role="log"
      aria-live="polite"
      aria-label="Program output"
      // Grows with the output and then scrolls: 5 lines at text-xs (1rem each)
      // plus p-3 top and bottom.
      className="max-h-[6.5rem] overflow-auto rounded-md p-3 font-mono text-xs"
    >
      {lines.map((line) => (
        <div
          key={line.id}
          data-stream={line.stream}
          className={cn('whitespace-pre-wrap', line.stream === 'stderr' && 'text-destructive')}
        >
          {line.text}
        </div>
      ))}
    </div>
  );
}

function OutputList({ outputs }: Readonly<{ outputs: ResultOutput[] }>): React.JSX.Element | null {
  if (outputs.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {outputs.map((output, index) =>
        output.type === 'image/png' ? (
          <Img
            // Result outputs have no stable identity beyond position within a run.
            key={index}
            src={`data:image/png;base64,${output.data}`}
            alt="Generated figure"
            className="max-w-full rounded-md"
          />
        ) : (
          <pre
            key={index}
            className="overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap"
          >
            {output.data}
          </pre>
        )
      )}
    </div>
  );
}

function PythonSandboxView({
  frame,
  code,
  state,
  errorText,
  onRun,
  onStop,
}: Readonly<{
  frame: React.JSX.Element;
  code: string;
  state: SandboxState;
  errorText: string | null;
  onRun: () => void;
  onStop: () => void;
}>): React.JSX.Element {
  const { status, phase, consoleLines, outputs, ready } = state;
  const isBusy = status === 'loading' || status === 'running';
  return (
    // Deliberately not `h-full`, unlike the render view: this frame is `h-0` and
    // everything visible here is ordinary content. Pinning the column to the
    // panel's height would make every child a shrinkable flex item, collapsing
    // the console and the source to a line apiece. Auto height lets the panel's
    // own scroll container take over.
    <div className="flex flex-col gap-3 p-4">
      {frame}
      {/* Controls and results sit above the source: what a reader acts on and
          what the run produced are the reason the panel is open, and the source
          is reference behind them. A long program would otherwise push its own
          output below the fold. */}
      <div className="flex gap-2">
        {/* Offered only while the panel holds a port to ask on. A frame that
            never announced itself leaves the panel in `error` with nothing to
            send through, and Stop — which needs no port, it replaces the frame
            — is the way back from that. */}
        <Button size="sm" onClick={onRun} disabled={!ready || isBusy}>
          Run
        </Button>
        <Button size="sm" variant="outline" onClick={onStop} disabled={status === 'booting'}>
          Stop
        </Button>
      </div>
      {isBusy ? <LoadingLine text={statusText(status, phase, null)} /> : null}
      <ErrorCard text={errorText} />
      <ConsoleStrip lines={consoleLines} />
      <OutputList outputs={outputs} />
      <HighlightedSource content={code} language="python" />
      <StatusMirror status={status} phase={phase} errorText={errorText} />
    </div>
  );
}

// The blank frame shows nothing while a render document boots, loads or fails,
// so an overlay carries the loading/error text; a settled render leaves the
// iframe clear.
function renderOverlay(
  status: DocumentRenderStatusValue,
  phase: LoadingPhase | null,
  errorText: string | null
): React.JSX.Element | null {
  if (status === 'booting' || status === 'loading' || status === 'running') {
    return <LoadingLine text={statusText(status, phase, null)} />;
  }
  if (status === 'error') return <ErrorCard text={errorText} />;
  return null;
}

function RenderSandboxView({
  frame,
  status,
  phase,
  errorText,
  pendingView,
}: Readonly<{
  frame: React.JSX.Element;
  status: DocumentRenderStatusValue;
  phase: LoadingPhase | null;
  errorText: string | null;
  pendingView: React.ReactNode;
}>): React.JSX.Element {
  const overlay = renderOverlay(status, phase, errorText);
  return (
    <div className="relative flex h-full flex-col">
      {frame}
      {status === 'streaming' ? pendingView : null}
      {overlay ? (
        <div className="absolute inset-0 flex items-center justify-center p-4">{overlay}</div>
      ) : null}
      <StatusMirror status={status} phase={phase} errorText={errorText} />
    </div>
  );
}

/**
 * What the panel shows in place of the frame's own verdict.
 *
 * Two things make a verdict unusable. The message may still be arriving, so a
 * failure describes half-written code the reader cannot act on. Or the code may
 * have moved on since the frame last saw it — a re-init sits in the debounce, or
 * is in flight — so the verdict is about text nobody is looking at any more. The
 * second case outlives the first: a message that settles right after its closing
 * fence delivers its last chunk and stops streaming in the same commit, leaving
 * a queued attempt behind it. Keying only on streaming would paint that stale
 * failure over the document for as long as the debounce runs.
 *
 * In either case the panel shows the last good render, or the source. A verdict
 * only reaches the reader once an attempt against the code they can see has
 * reported. Python is exempt: it runs only when the reader asks, so its answer
 * is theirs to see.
 */
function displayStatus(
  state: SandboxState,
  isStreaming: boolean,
  isPython: boolean,
  code: string
): DocumentRenderStatusValue {
  if (isPython) return state.status;
  const superseded = state.initializedCode !== null && state.initializedCode !== code;
  if (!isStreaming && !superseded) return state.status;
  return state.hasRendered ? 'rendered' : 'streaming';
}

/**
 * How long the frame is given to announce itself before the panel calls the
 * preview failed. Everything that must arrive first is a static asset of the
 * sandbox origin — the page and its bundle — because the frame posts `ready` as
 * that bundle evaluates, before it loads a runtime or a module, so no frame
 * budget covers this wait and none of them starts until a port exists. The
 * value is a slow cold fetch of that bundle with room to spare, and is
 * deliberately generous: calling a slow-but-healthy boot a failure puts a card
 * on screen that lies about what happened.
 */
export const BOOT_DEADLINE_MS = 15_000;

/**
 * How long the document must hold still before the frame is re-driven. Every
 * init costs a transpile and a mount, so a message that grows a token at a time
 * spends a handful of attempts on settled text instead of one per token.
 */
const REINIT_DEBOUNCE_MS = 300;

/**
 * Embeds the sandbox-origin renderer iframe and drives the typed bridge. All
 * untrusted document code executes inside this cross-origin, `allow-scripts`-only
 * frame — never in the app origin. html/js/react auto-render once the frame is
 * ready and re-render as the document grows; python waits for an explicit Run,
 * and Stop tears the frame down (the only way to kill a main-thread Python run).
 * The panel keys this component by the user's selection, so switching documents
 * remounts it with fresh state while a growing document keeps its frame.
 *
 * Whether a preview may run is never predicted from the source text — the frame
 * is handed the code and its answer is observed. While the message is still
 * streaming a reported failure is treated as unfinished code rather than broken
 * code, so nothing is shown for it.
 *
 * A react document may fail after it rendered — React tears its tree down when a
 * later commit round throws, which can happen once a lazily imported child
 * arrives or a deferred update lands. That failure retires the render it names
 * (the preview is gone, so there is nothing left to hold) and reaches the reader
 * through the same suppression rule as any other verdict.
 */
export function DocumentSandbox({
  kind,
  code,
  title,
  isStreaming,
  pendingView,
}: Readonly<DocumentSandboxProps>): React.JSX.Element {
  const isPython = kind === 'python';
  const iframeRef = React.useRef<HTMLIFrameElement>(null);
  const requestIdRef = React.useRef<string | null>(null);
  const requestCounterRef = React.useRef(0);
  const readyRef = React.useRef(false);
  const portRef = React.useRef<MessagePort | null>(null);
  const [state, dispatch] = React.useReducer(sandboxReducer, INITIAL_STATE);
  const { errorCode, frameKey } = state;

  const appearance = useFrameAppearance();
  // Read at post time rather than closed over, so the appearance stays out of
  // the senders' identities. `startAutoRun` is what the handshake listener and
  // the re-drive debounce are keyed on: were it to change with the theme, a
  // toggle would re-register the transport and restart a debounce in flight.
  const appearanceRef = React.useRef(appearance);
  // The document's text is read the same way, and for a second reason on top of
  // that one. `startAutoRun` is what the handshake listener is keyed on, and
  // that listener's cleanup is where the port is given up; a text that moved
  // with every streamed chunk would put the port of a live frame through
  // teardown mid-document, and a post to a closed port is dropped without a
  // throw, so the panel would wait on an answer nobody can ask for any more.
  const codeRef = React.useRef(code);

  const nextRequestId = React.useCallback((): string => {
    requestCounterRef.current += 1;
    return `req-${String(requestCounterRef.current)}`;
  }, []);

  const postToFrame = React.useCallback((message: ParentToFrameMessage): void => {
    // The port, never the frame's window. A sandboxed frame without
    // `allow-same-origin` has an opaque origin, so a window post naming the
    // sandbox origin is discarded without an error and a wildcard would reach
    // whatever document the frame navigated itself to. A port is a capability
    // bound to the document that received it: it dies with that document rather
    // than following the window.
    const port = portRef.current;
    // Loudly, never silently. Every sender is gated on the handshake that
    // captures the port, so no port means that gating broke — and a dropped
    // parent→frame message is the exact failure this transport exists to
    // prevent: the frame simply never answers and the panel reads the silence
    // as "Working…" forever. Both test embedders throw here for the same reason.
    /* v8 ignore next -- unreachable through the component's surface: every sender is gated on the port being held — Run on the state flag, the re-drive and theme effects on the ref — and {@link closePort}, the one place the port is given up, clears both in the same statement */
    if (!port) throw new Error('document sandbox: the frame transferred no port');
    port.postMessage(message);
  }, []);

  const startAutoRun = React.useCallback((): void => {
    const requestId = nextRequestId();
    requestIdRef.current = requestId;
    const code = codeRef.current;
    dispatch({ type: 'auto-start', code });
    postToFrame({ type: 'init', kind, code, requestId, ...appearanceRef.current });
  }, [kind, nextRequestId, postToFrame]);

  const runPython = React.useCallback((): void => {
    const requestId = nextRequestId();
    requestIdRef.current = requestId;
    dispatch({ type: 'python-start', code });
    postToFrame({ type: 'init', kind, code, requestId, ...appearanceRef.current });
    postToFrame({ type: 'run', requestId });
  }, [kind, code, nextRequestId, postToFrame]);

  // Giving up the port is what makes the frame's death final: it is a
  // capability, and closing it is the app stating it will neither send on that
  // channel nor accept what arrives on it. Only genuine teardown does this —
  // the frame that holds the other end is gone or is about to be replaced.
  // Every gate that lets a message be sent falls here, in the same statement
  // that gives the port up, so no control and no effect can offer to send on a
  // channel the panel no longer holds.
  const closePort = React.useCallback((): void => {
    portRef.current?.close();
    portRef.current = null;
    readyRef.current = false;
    dispatch({ type: 'port-closed' });
  }, []);

  const stop = React.useCallback((): void => {
    requestIdRef.current = null;
    // The frame this port belongs to is about to be replaced, and the fresh one
    // brings its own. Giving it up here is what lets the next handshake win.
    closePort();
    dispatch({ type: 'stop' });
  }, [closePort]);

  const handleFrameMessage = React.useCallback(
    (data: unknown): void => {
      const parsed = parseFrameToParentMessage(data);
      if (!parsed.success) return;
      const message = parsed.data;
      // `ready` is the handshake that hands over this very port; arriving on the
      // port itself it is noise, and re-running it would restart the document.
      if (message.type === 'ready') return;

      // Drop stale messages (teardown races, killed runs) so a dead frame can
      // never mutate the live UI.
      if (message.requestId !== requestIdRef.current) return;
      dispatch({ type: 'frame', message, isPython });
    },
    [isPython]
  );

  // A layout effect, not a passive one, and that is load-bearing. The iframe is
  // committed in this same render, and the frame's `ready` is one-shot: nothing
  // re-announces it, and nothing may — a re-announcement would reopen the
  // channel-hijack the first-ready-wins rule below closes. A passive effect runs
  // in a later task than the commit that inserted the frame, so a frame that
  // answers inside that gap would hand its port to nobody and the panel would
  // sit at "Working…" forever. Layout effects run synchronously within the
  // commit, before the event loop can deliver the frame's first message at all.
  // The gap is widest where the sandbox assets are local files (Capacitor) and
  // there is no network round trip to lose the race in.
  React.useLayoutEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const frame: MessageEventSource | null = iframeRef.current?.contentWindow ?? null;
      if (event.source !== frame) return;
      const parsed = parseFrameToParentMessage(event.data);
      if (!parsed.success) return;
      // The window carries the handshake and nothing else: every message about a
      // request rides the port the handshake transferred.
      if (parsed.data.type !== 'ready') return;
      // First ready wins, until the frame is replaced. Untrusted document code
      // shares the frame's realm and can announce a channel of its own; the
      // bootstrap runs first, so only its channel is ever taken.
      if (portRef.current) return;
      const port = event.ports[0];
      if (!port) return;

      portRef.current = port;
      port.addEventListener('message', (portEvent: MessageEvent): void => {
        handleFrameMessage(portEvent.data);
      });
      // A listener added this way leaves the port paused, unlike an `onmessage`
      // assignment; without this the frame's first report is never delivered.
      port.start();
      readyRef.current = true;
      dispatch({ type: 'handshake', isPython });
      if (!isPython) startAutoRun();
    };

    globalThis.addEventListener('message', onMessage);
    return () => {
      globalThis.removeEventListener('message', onMessage);
      closePort();
    };
  }, [isPython, startAutoRun, handleFrameMessage, closePort]);

  // Nothing else bounds the handshake. Every budget the frame keeps starts at
  // the `init` it is sent once its port arrives, so a frame that never got that
  // far — an unreachable sandbox origin, a blocked embed, a bootstrap that threw
  // before its one-shot `ready` — reports nothing and the panel would read that
  // silence as a preview still loading, forever. Armed per frame instance: a
  // replacement carries a new key and gets its own budget.
  React.useEffect(() => {
    const timer = setTimeout(() => {
      if (readyRef.current) return;
      dispatch({ type: 'boot-timeout' });
    }, BOOT_DEADLINE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [frameKey]);

  // Restyle a frame that is already holding a document. This is its own message
  // rather than a repeated `init` because `init` is how a document is loaded:
  // restating the appearance through it would re-execute whatever is running and
  // discard its state, so a reader switching theme would lose what was on screen.
  // Before the handshake there is no port and nothing to restyle — the `init`
  // that follows carries the appearance instead.
  React.useEffect(() => {
    appearanceRef.current = appearance;
    if (!readyRef.current) return;
    postToFrame({ type: 'theme', ...appearance });
  }, [appearance, postToFrame]);

  React.useEffect(() => {
    codeRef.current = code;
  }, [code]);

  // Re-drive the live frame once the code has held still. The frame itself is
  // never remounted for a new attempt: a fresh one would be blank, discarding
  // the render already on screen.
  React.useEffect(() => {
    if (isPython || !readyRef.current || code === state.initializedCode) return;
    const timer = setTimeout(startAutoRun, REINIT_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [code, isPython, state.initializedCode, startAutoRun]);

  const status = displayStatus(state, isStreaming, isPython, code);
  const errorText = errorCode ? DOCUMENT_ERROR_TEXT[errorCode] : null;

  const frame = (
    <iframe
      key={frameKey}
      ref={iframeRef}
      src={sandboxPageUrl(kind)}
      title={title}
      sandbox={DOCUMENT_IFRAME_SANDBOX_ATTR}
      className={cn(
        'w-full border-0',
        isPython || status === 'streaming' ? 'h-0' : 'min-h-0 flex-1'
      )}
    />
  );

  if (isPython) {
    return (
      <PythonSandboxView
        frame={frame}
        code={code}
        state={state}
        errorText={errorText}
        onRun={runPython}
        onStop={stop}
      />
    );
  }

  return (
    <RenderSandboxView
      frame={frame}
      status={status}
      phase={state.phase}
      errorText={errorText}
      pendingView={pendingView}
    />
  );
}
