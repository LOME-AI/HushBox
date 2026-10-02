import * as React from 'react';
import { type LucideIcon, Pause, Play, Square } from 'lucide-react';

import { TEST_SIGNALS, TTS_MODEL_DOWNLOAD_MB } from '@hushbox/shared';

import { Tooltip, TooltipContent, TooltipTrigger } from '../primitives/tooltip';
import { TtsDownloadBar } from '../accessibility/tts-download-bar';
import { useA11yStore } from '../accessibility/store';
import { cn } from '../../lib/utilities';
import type { ChunkHighlighter } from '../accessibility/lib/chunk-highlighter';
import type {
  DocumentReader,
  DocumentReaderChunk,
  DocumentReaderState,
} from '../accessibility/lib/document-reader';
import type { TtsVoice } from '../accessibility/lib/tts-engine';

// A post page marks its rendered body with `data-reading` and carries exactly
// one such article, so this selector is unambiguous there.
const DEFAULT_ARTICLE_SELECTOR = 'article[data-reading]';
const DOWNLOAD_LABEL = 'Preparing the voice';
const ERROR_TEXT = "Couldn't start playback. Try again.";
// The blog reader's local-processing disclosure, split into the two halves
// that render as the two desktop lines. The break is authored rather
// than left to wrapping so it cannot land somewhere ragged at a width nobody
// tested; the halves are balanced, not sentence-aligned, so neither overruns
// the reader column. The size comes from the shared figure so it cannot drift
// from the widget's copy.
const DISCLOSURE_LINE_1 = 'Local text to speech. First listen downloads';
const DISCLOSURE_LINE_2 = `the voice model (about ${TTS_MODEL_DOWNLOAD_MB.toString()} MB, one time).`;
/**
 * How long the load must run before the download bar is worth showing.
 * transformers.js exposes no cache-hit signal and a cached read replays
 * byte-identical progress events, so elapsed time is the only thing that
 * separates a download from a cache read. The window is sized so a cached load
 * never flashes a bar; the cost is that a real download's bar appears late.
 */
const DOWNLOAD_BAR_DWELL_MS = 900;

/** UI-facing lifecycle, collapsing the reader's `idle`/`stopped` into one idle state. */
type UiStatus = 'idle' | 'loading' | 'speaking' | 'paused' | 'error';

type ReaderModule = typeof import('../accessibility/lib/document-reader');
type HighlighterModule = typeof import('../accessibility/lib/chunk-highlighter');

/** Runs `action` only while the run that created it is still the current one. */
type RunGuard = (action: () => void) => void;

/** What painting a chunk needs: the live toggle state and the active highlighter. */
interface HighlightHandles {
  readonly highlightOnRef: React.RefObject<boolean>;
  readonly highlighterRef: React.RefObject<ChunkHighlighter | null>;
}

/** Stable handles a single read needs; assembled fresh per run from refs. */
interface RunContext extends HighlightHandles {
  readonly voice: TtsVoice;
  /** The context unlocked in the click; the engine adopts it as its player. */
  readonly audioCtx: AudioContext;
  /** The chunk being spoken, so the toggle can repaint without the reader. */
  readonly lastChunkRef: React.RefObject<DocumentReaderChunk | null>;
  readonly readerRef: React.RefObject<DocumentReader | null>;
  readonly applyReaderState: (next: DocumentReaderState) => void;
  readonly setPercent: (pct: number) => void;
  readonly setAudioStarted: (started: boolean) => void;
}

/** Paint (or, when highlighting is off, clear) the chunk currently being read. */
function paintChunk(handles: HighlightHandles, chunk: DocumentReaderChunk): void {
  if (handles.highlightOnRef.current) {
    handles.highlighterRef.current?.highlight({
      blockEl: chunk.blockEl,
      startOffset: chunk.startOffset,
      endOffset: chunk.endOffset,
    });
  } else {
    handles.highlighterRef.current?.clear();
  }
}

/** Build the highlighter + reader and kick off playback for one run. */
function wireReader(
  modules: { reader: ReaderModule; highlighter: HighlighterModule },
  container: HTMLElement,
  ctx: RunContext,
  live: RunGuard
): void {
  ctx.highlighterRef.current = modules.highlighter.createChunkHighlighter(container);
  const documentReader = modules.reader.createDocumentReader({
    container,
    voice: ctx.voice,
    onChunk: (chunk) => {
      live(() => {
        ctx.lastChunkRef.current = chunk;
        paintChunk(ctx, chunk);
      });
    },
    onState: (next) => {
      live(() => {
        ctx.applyReaderState(next);
      });
    },
    onDownloadProgress: ({ pct }) => {
      live(() => {
        ctx.setPercent(pct);
      });
    },
    onAudioStart: () => {
      live(() => {
        ctx.setAudioStarted(true);
      });
    },
  });
  ctx.readerRef.current = documentReader;
  // Fires the read; never rejects (engine failures surface via onState('error')).
  void documentReader.start(ctx.audioCtx);
}

/**
 * Create (once) the AudioContext that will play the read, restart it if the
 * browser has stopped it, and prime it with a silent buffer. iOS Safari unlocks
 * audio per AudioContext instance and only from inside the gesture's own
 * synchronous call stack — an `await` drops WebKit's user-activation token — so
 * this must run before the dynamic import that loads the engine, and the very
 * context unlocked here is what the engine then adopts. A later listen re-primes
 * that same instance: the engine keeps the first context it adopts, and browsers
 * cap how many contexts one page may hold.
 *
 * The `resume()` cannot be left to the engine. A context is born suspended on
 * iOS, and backgrounding the tab moves it to WebKit's `interrupted` state, which
 * nothing recovers on its own; the engine's own recovery matches `suspended`
 * only and runs outside the gesture, where WebKit no longer honours it.
 */
function primeAudioContext(existing: AudioContext | null): AudioContext {
  const ctx = existing ?? new AudioContext();
  if (ctx.state !== 'running') void ctx.resume();
  const source = ctx.createBufferSource();
  source.buffer = ctx.createBuffer(1, 1, 22_050);
  source.connect(ctx.destination);
  source.start(0);
  return ctx;
}

/**
 * The band's reserved status slot: the download bar and the error line render
 * here, in the gap between the byline block and the reader stack. The slot is
 * always present so neither arrival reflows the band.
 *
 * Where the band is a row its height is the largest of its members' heights, and
 * `self-center` does not exempt this slot from that maximum — centring only
 * stops it being stretched. The reservation is therefore free only while this
 * slot's content stays shorter than the byline block, so a second line here (a
 * bytes/speed/ETA row, as the accessibility widget's audio section renders)
 * would grow the band. Where the band is a column an empty slot collapses
 * instead.
 */
function BandStatusSlot({
  status,
  percent,
  showDownloadBar,
}: {
  readonly status: UiStatus;
  readonly percent: number;
  readonly showDownloadBar: boolean;
}): React.JSX.Element {
  let content: React.JSX.Element | null = null;
  if (showDownloadBar) {
    content = <TtsDownloadBar percent={percent} label={DOWNLOAD_LABEL} showLabel />;
  } else if (status === 'error') {
    content = (
      <p role="alert" className="text-destructive text-xs">
        {ERROR_TEXT}
      </p>
    );
  }
  return (
    <div
      data-slot="blog-reader-status"
      className="w-full min-w-0 self-center max-md:empty:hidden md:max-w-88 md:flex-1"
    >
      {content}
    </div>
  );
}

/** The four actions the one transport control can carry. */
interface TransportActions {
  readonly onStart: () => void;
  readonly onStop: () => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
}

/** What the transport control says and does in one UI state. */
interface Transport {
  readonly label: TransportLabel;
  /** Kept equal to, or a suffixed form of, the visible label (WCAG label in name). */
  readonly name: string;
  readonly Icon: LucideIcon;
  readonly onClick: () => void;
}

/**
 * Every label the transport can show. All of them sit in one grid cell with only
 * the current one visible, so the control is always as wide as its widest label
 * and relabelling mid-read never resizes the pill around it.
 */
const TRANSPORT_LABELS = ['Listen', 'Stop', 'Pause', 'Resume'] as const;
type TransportLabel = (typeof TRANSPORT_LABELS)[number];

function transportFor(status: UiStatus, actions: TransportActions): Transport {
  switch (status) {
    case 'speaking': {
      return { label: 'Pause', name: 'Pause', Icon: Pause, onClick: actions.onPause };
    }
    case 'paused': {
      return { label: 'Resume', name: 'Resume', Icon: Play, onClick: actions.onResume };
    }
    case 'loading': {
      // The model download has no cancel, so ending the read outright is all
      // this state can offer; pausing becomes possible once audio is playing.
      return { label: 'Stop', name: 'Stop', Icon: Square, onClick: actions.onStop };
    }
    default: {
      return { label: 'Listen', name: 'Listen to this post', Icon: Play, onClick: actions.onStart };
    }
  }
}

/**
 * One segment of the pill. The dimming is a variant on one class list rather
 * than a swapped set, so a segment's box is identical whether or not it is
 * disabled and the header band cannot reflow when the island comes alive; both
 * segments carry it, because a pill where one half admits it is not ready while
 * the other silently swallows clicks reads as broken. On a coarse pointer an
 * invisible layer extends the hit area to 2.75rem without changing the pill.
 */
const PILL_SEGMENT =
  'group hover:bg-accent text-sm font-medium relative inline-flex h-8 items-center gap-2 rounded-full transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50 pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-inset-y-1.5';

/**
 * The reader's only transport: Listen, then Pause, then Resume. One button rather
 * than a transport row is a product decision — a paused read is resumed or
 * abandoned by leaving the page (each post load is a fresh page), never stopped
 * back to the top from here.
 */
function TransportButton({
  status,
  disabled,
  actions,
}: {
  readonly status: UiStatus;
  readonly disabled: boolean;
  readonly actions: TransportActions;
}): React.JSX.Element {
  const { label, name, Icon, onClick } = transportFor(status, actions);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={name}
      className={cn(PILL_SEGMENT, 'text-foreground pr-3.5 pl-1')}
    >
      <span
        aria-hidden="true"
        className="bg-primary text-primary-foreground grid size-6 flex-none place-items-center rounded-full"
      >
        {/* The play triangle's mass sits left of its box, so it is nudged to look centred. */}
        <Icon
          className={cn('size-2.5', Icon === Play && 'translate-x-px')}
          fill="currentColor"
          aria-hidden="true"
        />
      </span>
      <span className="grid">
        {TRANSPORT_LABELS.map((each) => (
          <span key={each} className={cn('col-start-1 row-start-1', each !== label && 'invisible')}>
            {each}
          </span>
        ))}
      </span>
    </button>
  );
}

/** Always-visible highlight-while-reading switch with its hover/focus tooltip. */
function HighlightToggle({
  on,
  disabled,
  onToggle,
}: {
  readonly on: boolean;
  readonly disabled: boolean;
  readonly onToggle: () => void;
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Highlight while reading"
          onClick={onToggle}
          disabled={disabled}
          className={cn(PILL_SEGMENT, 'text-muted-foreground pr-2 pl-3')}
        >
          Highlight
          {/*
            The track follows the switch's own checked state, so the look cannot
            disagree with what assistive technology is told. Each checked colour
            is declared under `dark:` too: a stacked dark variant outranks a lone
            group variant, so the dark off colour would otherwise paint over it.
          */}
          <span
            aria-hidden="true"
            className="bg-input dark:bg-input/80 group-aria-checked:bg-primary dark:group-aria-checked:bg-primary relative h-4 w-7 flex-none rounded-full transition-colors duration-150"
          >
            <span className="bg-background dark:bg-foreground group-aria-checked:bg-primary-foreground dark:group-aria-checked:bg-primary-foreground absolute top-0.5 left-0.5 size-3 rounded-full transition-transform duration-150 group-aria-checked:translate-x-3" />
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{`Highlight while reading: ${on ? 'on' : 'off'}`}</TooltipContent>
    </Tooltip>
  );
}

interface BlogReadAloudProps {
  /**
   * CSS selector for the rendered article to read aloud. Defaults to the blog
   * post's `article[data-reading]` container.
   */
  readonly articleSelector?: string;
}

/**
 * Blog "Listen" control, reading the post aloud on-device. It renders the reader
 * stack and the status slot as two siblings rather than one root because they
 * are two separate members of the post header's band, with the byline block's
 * gap between them; the mount point must therefore be a flex or grid container,
 * Astro's island wrapper being `display: contents` and interposing no box.
 * Voice comes from the shared accessibility store, and the read never gates on
 * the chat read-aloud toggles.
 */
export function BlogReadAloud({
  articleSelector = DEFAULT_ARTICLE_SELECTOR,
}: BlogReadAloudProps): React.JSX.Element {
  const voice = useA11yStore((s) => s.ttsVoice);
  const readingHighlight = useA11yStore((s) => s.readingHighlight);
  const update = useA11yStore((s) => s.update);

  const [status, setStatus] = React.useState<UiStatus>('idle');
  const [percent, setPercent] = React.useState(0);
  // True only from the moment the engine actually schedules audio on the
  // AudioContext (the document reader's onAudioStart) until the next state
  // transition that isn't "still speaking the same segment" — reset on every
  // applyReaderState call (loading/paused/error/idle all mean no audio is
  // playing) and on handleStop. A pause clears it and a resume re-arms it:
  // the signal means "audio is playing right now", not "has ever played".
  const [audioStarted, setAudioStarted] = React.useState(false);
  // The island is rendered into the page's HTML but carries no behaviour until
  // its script has loaded and hydrated it, which is not instant even at first
  // paint. Until then every handler below is absent, so a click on a control
  // that looks live does nothing at all and the reader appears broken. Starting
  // false on the server and on the first client render (the two must agree, or
  // hydration mismatches) and flipping in an effect — which only runs once the
  // island is live — is what lets the control say so.
  const [hydrated, setHydrated] = React.useState(false);
  React.useEffect(() => {
    setHydrated(true);
  }, []);

  const readerRef = React.useRef<DocumentReader | null>(null);
  const highlighterRef = React.useRef<ChunkHighlighter | null>(null);
  // The chunk currently being spoken. The reader exposes no accessor for it, so
  // retaining it here is what lets the toggle repaint mid-sentence instead of
  // waiting for the reader to reach the next chunk. Nulled whenever the read
  // ends, so a toggle after a finished read cannot resurrect a stale sentence.
  const lastChunkRef = React.useRef<DocumentReaderChunk | null>(null);
  const audioCtxRef = React.useRef<AudioContext | null>(null);
  // Monotonic run token: a stop bumps it so late work from a torn-down or
  // in-flight reader (dynamic import still resolving) is ignored.
  const runIdRef = React.useRef(0);

  // Mirrors read inside stable callbacks / listeners so they see current values
  // without re-subscribing.
  const voiceRef = React.useRef(voice);
  const highlightOnRef = React.useRef(readingHighlight);
  const statusRef = React.useRef<UiStatus>(status);
  React.useEffect(() => {
    voiceRef.current = voice;
  }, [voice]);
  React.useEffect(() => {
    statusRef.current = status;
  }, [status]);
  React.useEffect(() => {
    highlightOnRef.current = readingHighlight;
    // Symmetric on purpose: off removes the live indicator at once, and on
    // repaints the sentence being spoken. `paintChunk` picks the direction from
    // the ref just assigned; with no retained chunk there is nothing to paint.
    const chunk = lastChunkRef.current;
    if (chunk === null) highlighterRef.current?.clear();
    else paintChunk({ highlightOnRef, highlighterRef }, chunk);
  }, [readingHighlight]);

  // Second half of the gate: the bar waits out `DOWNLOAD_BAR_DWELL_MS` of
  // `loading` before it may appear. Any exit from `loading` (including the
  // error path, which never reaches 100%) drops the flag and cancels the timer,
  // so the gate can never leave the bar waiting on a completion that stopped
  // coming.
  const [dwellElapsed, setDwellElapsed] = React.useState(false);
  React.useEffect(() => {
    setDwellElapsed(false);
    if (status !== 'loading') return;
    const timer = globalThis.setTimeout(() => {
      setDwellElapsed(true);
    }, DOWNLOAD_BAR_DWELL_MS);
    return () => {
      globalThis.clearTimeout(timer);
    };
  }, [status]);
  // The load reports exactly one 100% before it finishes, so a full bar means
  // the download is done and only warmup remains: drop it rather than parking a
  // full bar on screen until `speaking`.
  const showDownloadBar = status === 'loading' && dwellElapsed && percent < 100;
  // Audio has actually begun playing (the reader's onAudioStart, sourced from
  // the engine scheduling a buffer on the AudioContext) — never merely
  // "download finished" or "the reader entered its speaking phase", both of
  // which precede any audio.
  const speakingAttribute = audioStarted ? { [TEST_SIGNALS.blogSpeaking]: 'true' } : {};

  const applyReaderState = React.useCallback((next: DocumentReaderState): void => {
    // Every transition this function handles means "no audio is playing right
    // now", including a fresh 'speaking' — that state is entered before the
    // first speak() of the segment is even issued. Only onAudioStart (wired
    // separately, in wireReader) sets this true.
    setAudioStarted(false);
    switch (next) {
      case 'loading': {
        setStatus('loading');
        break;
      }
      case 'speaking': {
        setStatus('speaking');
        break;
      }
      case 'paused': {
        // Deliberately keeps `lastChunkRef` and the painted highlight: the
        // sentence on screen is the only marker of where the read will pick up.
        setStatus('paused');
        break;
      }
      case 'error': {
        lastChunkRef.current = null;
        highlighterRef.current?.clear();
        setStatus('error');
        break;
      }
      case 'idle':
      case 'stopped': {
        lastChunkRef.current = null;
        highlighterRef.current?.clear();
        setStatus('idle');
        break;
      }
      default: {
        // Compile-time exhaustiveness. Without it a widened
        // DocumentReaderState still type-checks here and the new state falls
        // through as a silent no-op — which is exactly how 'paused' arrived.
        const unhandled: never = next;
        return unhandled;
      }
    }
  }, []);

  const handleStop = React.useCallback((): void => {
    runIdRef.current += 1;
    lastChunkRef.current = null;
    readerRef.current?.stop();
    readerRef.current = null;
    highlighterRef.current?.clear();
    highlighterRef.current = null;
    setStatus('idle');
    setPercent(0);
    setAudioStarted(false);
  }, []);

  const handlePause = React.useCallback((): void => {
    // Deliberately narrow, and nothing like handleStop: the run token is not
    // bumped and neither the reader nor the highlighter is released, because a
    // resumed read is the same run still reporting through the same callbacks.
    // Bumping the token here would make `live` drop every one of them — a
    // control reading "Resume" over silence, with nothing raising an error.
    // The reader's own pause() stops the engine, so there is no stop() here.
    readerRef.current?.pause();
  }, []);

  const handleResume = React.useCallback((): void => {
    // The same in-gesture unlock the first listen performs: while the read was
    // paused the browser may have suspended or interrupted the context, and
    // only this synchronous stack can restart it.
    audioCtxRef.current = primeAudioContext(audioCtxRef.current);
    // Never rejects; a failure surfaces through onState('error').
    void readerRef.current?.resume();
  }, []);

  const handleStart = React.useCallback(async (): Promise<void> => {
    // Only ever invoked from the Listen button, which renders only while idle,
    // so there is no re-entrant start to guard against.
    const container = document.querySelector<HTMLElement>(articleSelector);
    if (container === null) {
      console.error('Blog reader: no article element matched selector', articleSelector);
      setStatus('error');
      return;
    }
    const runId = (runIdRef.current += 1);
    // A stop (button, Esc, unmount) bumps runIdRef; `live` then drops every
    // effect of this run — the reader creation itself and each later callback.
    const live: RunGuard = (action) => {
      if (runIdRef.current === runId) action();
    };
    setPercent(0);
    setStatus('loading');
    setAudioStarted(false);
    try {
      // Still inside the click's synchronous call stack — the iOS unlock is
      // only valid here, before the import below is awaited.
      const audioCtx = (audioCtxRef.current = primeAudioContext(audioCtxRef.current));
      // First-click only: the reader module pulls the TTS engine, kept out of
      // the initial marketing bundle by loading it here rather than statically.
      const [reader, highlighter] = await Promise.all([
        import('../accessibility/lib/document-reader'),
        import('../accessibility/lib/chunk-highlighter'),
      ]);
      const ctx: RunContext = {
        voice: voiceRef.current,
        audioCtx,
        highlightOnRef,
        highlighterRef,
        lastChunkRef,
        readerRef,
        applyReaderState,
        setPercent,
        setAudioStarted,
      };
      live(() => {
        wireReader({ reader, highlighter }, container, ctx, live);
      });
    } catch (error) {
      console.error('Blog reader: failed to start playback', error);
      applyReaderState('error');
    }
  }, [applyReaderState, articleSelector]);

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      // Escape does whatever the control does, so the two never disagree: it
      // pauses playback, and ends the read only while the model is loading,
      // where there is nothing to pause.
      if (statusRef.current === 'speaking') handlePause();
      else if (statusRef.current === 'loading') handleStop();
    }
    globalThis.addEventListener('keydown', onKeyDown);
    return () => {
      globalThis.removeEventListener('keydown', onKeyDown);
    };
  }, [handlePause, handleStop]);

  React.useEffect(
    () => () => {
      readerRef.current?.stop();
    },
    []
  );

  return (
    <>
      <BandStatusSlot status={status} percent={percent} showDownloadBar={showDownloadBar} />

      <div
        data-slot="blog-reader-stack"
        {...speakingAttribute}
        className="flex w-full min-w-0 md:w-72 md:flex-none"
      >
        {/*
          In flow on purpose: the pill and the disclosure beneath it stand
          taller than the byline block, so where the band is a row the band
          grows to fit them. A contents box taken out of flow and clipped to
          the band's height would cut the pill's border.
        */}
        <div className="@container/reader flex w-full flex-col items-center justify-center gap-2 text-center">
          <div
            role="group"
            aria-label="Read aloud"
            // 2.5rem tall on one row from its padding rather than a fixed height
            // (1px border + (0.25rem - 1px) + a 2rem part, each side), so the
            // stacked layout grows around its two rows. The radius is half that
            // one-row height: a full pill on one row, a rounded box on two.
            //
            // The parts stack below the one-row pill's own width, derived rather
            // than tuned: 7.375rem of padding, disc, gaps, hairline margin and
            // track, plus the two labels ("Resume", the widest transport label,
            // and "Highlight") at 7.6em of their 0.875rem text, measured across
            // the widget's text scales, plus 3px of border and hairline. The
            // layouts are explicit rather than wrapped so no row ever ends in
            // the hairline.
            //
            // The accessibility widget's classes on <html> widen the labels, so
            // each gates its own threshold. The font override takes the widest
            // face it can set, OpenDyslexic, whose one-row pill measures at most
            // 16.22rem + 3px across the text scales. A letter spacing reaches the
            // transport labels only (the widget spaces spans), so it adds its em
            // over the six characters of "Resume" at 0.875rem: 0.2625rem loose,
            // 0.63rem loosest. Where several gates match, the widest wins, since
            // every rule only ever stacks.
            className="border-border-control bg-background inline-flex max-w-full items-center rounded-[1.25rem] border px-1 py-[calc(0.25rem-1px)] shadow-xs @max-[calc(14.03rem_+_3px)]/reader:flex-col [.a11y-font-override_&]:@max-[calc(16.22rem_+_3px)]/reader:flex-col [.a11y-font-override.a11y-letter-spacing-loose_&]:@max-[calc(16.22rem_+_0.2625rem_+_3px)]/reader:flex-col [.a11y-font-override.a11y-letter-spacing-loosest_&]:@max-[calc(16.22rem_+_0.63rem_+_3px)]/reader:flex-col [.a11y-letter-spacing-loose_&]:@max-[calc(14.03rem_+_0.2625rem_+_3px)]/reader:flex-col [.a11y-letter-spacing-loosest_&]:@max-[calc(14.03rem_+_0.63rem_+_3px)]/reader:flex-col"
          >
            <TransportButton
              status={status}
              disabled={!hydrated}
              actions={{
                onStart: () => void handleStart(),
                onStop: handleStop,
                onPause: handlePause,
                onResume: handleResume,
              }}
            />
            {/*
              One class list for both layouts: a 1px basis on the pill's main
              axis and a stretch across it make a vertical line in the row
              (1.25rem tall, the 2rem parts less its margins) and a horizontal
              one between the stacked rows. Stacked, its 0.375rem on each side
              is the reach of each part's coarse-pointer layer, so neither
              part's touch target overlaps the other's.
            */}
            <span
              aria-hidden="true"
              className="bg-border mx-0.5 my-1.5 flex-[0_0_1px] self-stretch"
            />
            <HighlightToggle
              on={readingHighlight}
              disabled={!hydrated}
              onToggle={() => {
                update({ readingHighlight: !readingHighlight });
              }}
            />
          </div>

          <p
            data-slot="blog-reader-disclosure"
            className="text-muted-foreground text-[0.7rem] leading-snug"
          >
            {/*
              Each half is its own line where the band is a row, so the
              disclosure is two lines at desktop widths wherever each half fits
              the column; a half the widget's font, size or spacing widens past
              the column wraps within itself rather than running off the page.
              Below the breakpoint the halves rejoin as inline text and wrap to
              three, which is deliberate. The space between them belongs to
              that joined-up sentence.
            */}
            <span className="block max-md:inline">{DISCLOSURE_LINE_1}</span>{' '}
            <span className="block max-md:inline">{DISCLOSURE_LINE_2}</span>
          </p>
        </div>
      </div>
    </>
  );
}
