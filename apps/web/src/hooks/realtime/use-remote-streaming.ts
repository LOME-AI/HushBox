import * as React from 'react';
import { useAnimationFrame } from '@hushbox/ui';
import { useMessages } from '@/hooks/chat/chat.js';
import { isLocalRun } from '@/lib/chat/run-ownership.js';
import { createStreamContentBuilder } from '@/lib/chat/stream-content-builder.js';
import type { ResolvedReasoningEffort, WireInferenceEvent } from '@hushbox/shared';
import type { ConversationWebSocket } from '@/lib/api/ws-client.js';
import type { RunFrame } from '@/lib/api/server-frames.js';
import type { StreamContentBuilder } from '@/lib/chat/stream-content-builder.js';

export interface PhantomMessage {
  content: string;
  senderType: 'user' | 'assistant';
  senderId?: string;
  modelName?: string;
  /** The finish frame's billed reasoning token count, as the sender's own tile receives it. */
  reasoningTokens?: number;
  /** The finish frame's resolved reasoning level, as the sender's own tile receives it. */
  reasoningEffort?: ResolvedReasoningEffort;
  /** The run finished and the tile waits for its stored row: shown, no longer streaming. */
  awaitingStoredRow?: true;
}

type PhantomPatch = Partial<
  Pick<PhantomMessage, 'content' | 'reasoningTokens' | 'reasoningEffort'>
>;

/** A stream's tile before any of its content has been published. */
const EMPTY_PHANTOM: PhantomMessage = { content: '', senderType: 'assistant' };

function patchPhantoms(
  previous: Map<string, PhantomMessage>,
  patches: ReadonlyMap<string, PhantomPatch>
): Map<string, PhantomMessage> {
  const next = new Map(previous);
  for (const [key, patch] of patches) {
    next.set(key, { ...EMPTY_PHANTOM, ...next.get(key), ...patch });
  }
  return next;
}

/** A finished stream's settled content and its billed reasoning facts, as one phantom patch. */
function finishedPatch(
  builder: StreamContentBuilder,
  event: Extract<WireInferenceEvent, { kind: 'finish' }>
): PhantomPatch {
  builder.settle();
  const content = builder.take();
  const { reasoningTokens } = event.metadata.usage;
  return {
    ...(content !== undefined && { content }),
    ...(reasoningTokens !== undefined && { reasoningTokens }),
    ...(event.reasoningEffort !== undefined && { reasoningEffort: event.reasoningEffort }),
  };
}

/** The tiles still waiting for their stored rows, which no run boundary releases. */
function waitingTiles(phantoms: Map<string, PhantomMessage>): Map<string, PhantomMessage> {
  const kept = new Map<string, PhantomMessage>();
  for (const [key, phantom] of phantoms) {
    if (phantom.awaitingStoredRow === true) kept.set(key, phantom);
  }
  return kept;
}

/** The tiles already waiting, plus the finished tiles of a run that just succeeded, now waiting too. */
function awaitingStoredRows(
  phantoms: Map<string, PhantomMessage>,
  finished: ReadonlySet<string>
): Map<string, PhantomMessage> {
  const kept = waitingTiles(phantoms);
  for (const [key, phantom] of phantoms) {
    if (finished.has(key)) kept.set(key, { ...phantom, awaitingStoredRow: true });
  }
  return kept;
}

/** The tiles less every waiting tile whose id the stored history holds; the same map when none. */
function releaseStored(
  phantoms: Map<string, PhantomMessage>,
  storedIds: ReadonlySet<string>
): Map<string, PhantomMessage> {
  const released = [...phantoms].filter(
    ([key, phantom]) => phantom.awaitingStoredRow === true && storedIds.has(key)
  );
  if (released.length === 0) return phantoms;
  const next = new Map(phantoms);
  for (const [key] of released) next.delete(key);
  return next;
}

/**
 * Renders OTHER members' live runs. Every room socket receives the same
 * `stream`/run frames; runs this tab started are already rendered by the send
 * path, so they are filtered out via run ownership (frames arriving before
 * the local POST resolves count as local — one run per conversation makes
 * that safe). Each phantom tile is keyed by the id its `stream-start` names,
 * the id its stored row carries, so per-message view state follows the answer
 * rather than a stream id the next run reuses. Each stream's content is built
 * from every one of its events through the same builder the sender's own tile
 * uses, so a watcher sees exactly what the sender sees, reasoning and searches
 * included.
 *
 * A succeeded run's finished tiles stay after `run-finished`, marked as
 * awaiting their stored rows, through any later run and any failed history
 * refetch. Each is released once the conversation's stored history, across
 * every fork, holds its id. The page shows a tile only while its fork's rows
 * lack that id, so on the viewed fork the stored row replaces the tile in the
 * render that brings it, and the row element is never unmounted between the two;
 * an answer stored on another fork leaves the view once it is stored.
 */
export function useRemoteStreaming(ws: ConversationWebSocket | null): Map<string, PhantomMessage> {
  const [phantoms, setPhantoms] = React.useState<Map<string, PhantomMessage>>(new Map());
  // Whether the currently-live run is remote. null = no run observed yet;
  // stream frames arriving without a run-started verdict are held back (the
  // legacy hook similarly ignored unattributable tokens).
  const remoteRunRef = React.useRef<boolean | null>(null);
  // The run every builder and phantom belongs to; null = none.
  const runRef = React.useRef<string | null>(null);
  // Builders and finished tiles are keyed like the phantoms, by stored id.
  const buildersRef = React.useRef(new Map<string, StreamContentBuilder>());
  const streamKeysRef = React.useRef(new Map<string, string>());
  const finishedRef = React.useRef(new Set<string>());
  // The keys a stream-start named as the answer's stored id; only those can meet a stored row.
  const storedKeysRef = React.useRef(new Set<string>());
  // Tiles awaiting their stored rows take no more content, so they need no frames.
  const streaming = [...phantoms.values()].some((phantom) => phantom.awaitingStoredRow !== true);

  // Streamed text is content, not animation: it must keep updating under reduced motion.
  useAnimationFrame(
    () => {
      const patches = new Map<string, PhantomPatch>();
      for (const [key, builder] of buildersRef.current) {
        const content = builder.take();
        if (content !== undefined) patches.set(key, { content });
      }
      if (patches.size > 0) setPhantoms((previous) => patchPhantoms(previous, patches));
    },
    { respectMotion: false, paused: !streaming }
  );

  // The whole stored history, before any fork filter, read through the page's own
  // messages query, so its notifications arrive batched with the page's, never during
  // another component's render. With no socket the id is empty, and the query is disabled.
  const { data: storedHistory } = useMessages(ws?.conversationId ?? '');

  // Runs after the render that brought the stored rows, in which the page already
  // drew each viewed-fork row in its tile's place.
  React.useEffect(() => {
    if (storedHistory === undefined) return;
    const storedIds = new Set(storedHistory.map((message) => message.id));
    setPhantoms((previous) => releaseStored(previous, storedIds));
  }, [storedHistory]);

  React.useEffect(() => {
    if (!ws) return;

    const conversationId = ws.conversationId;
    const builders = buildersRef.current;
    const streamKeys = streamKeysRef.current;
    const finished = finishedRef.current;
    const storedKeys = storedKeysRef.current;
    const forgetStreams = (): void => {
      builders.clear();
      streamKeys.clear();
      finished.clear();
      storedKeys.clear();
    };
    // A re-executed run reuses its stream ids, and a run that died sent no
    // run-finished, so nothing an earlier run built or streamed may carry into
    // another run. A tile waiting for its stored row is a finished answer under
    // its own unique id, so it stays.
    const enterRun = (runId: string | null): void => {
      runRef.current = runId;
      forgetStreams();
      setPhantoms(waitingTiles);
    };
    // A succeeded run's finished tiles wait for their stored rows, when their
    // stream named the id to wait for; every other tile of the run, and every
    // tile of any other outcome, has no stored row to wait for.
    const finishRun = (succeeded: boolean): void => {
      remoteRunRef.current = null;
      runRef.current = null;
      const kept = new Set(succeeded ? [...finished].filter((key) => storedKeys.has(key)) : []);
      forgetStreams();
      setPhantoms((previous) => awaitingStoredRows(previous, kept));
    };
    // `run-started` is broadcast once, so a socket that reconnects after a run
    // started learns that run only from `ready`. That run's start was missed,
    // so its frames are held back like any run seen without a verdict.
    const unsubscribeLiveRun = ws.onLiveRun((runId) => {
      if ((runId ?? null) === runRef.current) return;
      remoteRunRef.current = null;
      enterRun(runId ?? null);
    });
    const onStreamFrame = (frame: Extract<RunFrame, { type: 'stream' }>): void => {
      const event = frame.event;
      if (event.kind === 'stream-start') {
        const key = event.messageId ?? frame.streamId;
        streamKeys.set(frame.streamId, key);
        if (event.messageId !== undefined) storedKeys.add(key);
        setPhantoms((previous) => {
          const next = new Map(previous);
          next.set(key, { content: '', senderType: 'assistant', modelName: event.modelId });
          return next;
        });
        return;
      }

      const key = streamKeys.get(frame.streamId) ?? frame.streamId;
      let builder = builders.get(key);
      if (builder === undefined) {
        builder = createStreamContentBuilder();
        builders.set(key, builder);
        setPhantoms((previous) =>
          previous.has(key) ? previous : new Map(previous).set(key, EMPTY_PHANTOM)
        );
      }
      builder.feed(event);
      if (event.kind !== 'finish') return;
      if (event.metadata.finishReason !== 'error') finished.add(key);

      // A finished stream shows its settled content at once, not on the next frame.
      const patch = finishedPatch(builder, event);
      setPhantoms((previous) => patchPhantoms(previous, new Map([[key, patch]])));
    };
    const unsubscribe = ws.onRunFrame((frame) => {
      if (frame.type === 'run-started') {
        remoteRunRef.current = !isLocalRun(conversationId, frame.runId);
        enterRun(frame.runId);
        return;
      }
      if (frame.type === 'run-finished') {
        finishRun(frame.outcome.outcome === 'succeeded');
        return;
      }
      if (frame.type === 'stream' && remoteRunRef.current === true) onStreamFrame(frame);
    });

    return (): void => {
      unsubscribeLiveRun();
      unsubscribe();
    };
  }, [ws]);

  return phantoms;
}
