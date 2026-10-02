# Realtime

The conversation room's WebSocket protocol: how a client attaches, how a reconnect
replays what it missed, how many sockets a principal may hold, and how membership is
revalidated. The design claims — the WebSocket is the sole transport, a disconnect never
cancels a run, replay is negotiated at connection setup — are in `docs/ARCHITECTURE.md`
§Streaming & realtime. Read this when touching the room, the client's socket, stream
cursors, or session and link revocation.

## Transport

The conversation Durable Object's hibernatable WebSocket carries turn tokens, flow
progress, presence and media events. `POST /chat` initiates the run and returns a
handle; everything after rides the socket. A transport disconnect never cancels: the
turn completes, persists and bills server-side, because a Durable Object sustains
minutes-long fetches after the client is gone.

A run may hold several streams (`streamId`), each with its own cursor; fan-out width
respects the platform's connection cap per client. Values move through the in-memory
`ValueStore`, byte-metered to 20 MB on the assumption of a 3× real-memory multiplier over
the serialized size; a definition whose declared values exceed it (large video) is
rejected at validation.
Mid-flow content never rests anywhere; finals wrap to the epoch key at persist.

A watching member builds a streaming answer from the same frames as its owner, through the one
stream-content builder (`apps/web/src/lib/chat/stream-content-builder.ts`); no frame kind the
owner renders is dropped for a watcher.

## Replay

Replay is negotiated at connection setup, never after it. The reconnecting client
declares its per-stream cursors — or an explicit empty list — on the WebSocket upgrade
URL. The room withholds the fresh socket from run-frame fan-out until it has replayed
exactly the declared gap from a memory-only buffer, which carries per-stream and
run-total byte caps and evicts finished streams first.

Every cursor names its run, and one that names none is refused: matched against a newer
run, it could replay that run's frames with no gap signal.

## Socket cap and eviction

A room bounds how many sockets one principal holds. At the cap it closes that principal's
oldest socket, and the reconnect replays the declared gap — so the cap costs socket
rotation, never lockout. That eviction is also what reaps a silently-dead socket: nothing
else bounds how long an orphan holds a slot, and a second cleanup path would be a backup
mechanism. A link guest's principal is its link, so a shared link's whole guest audience
draws on one budget.

## Stop

Explicit stop is an HTTP route (`POST /chat/stop`), independent of the socket, that
settles the billable partial; because that settlement bills, the room refuses any caller
but the run's sender or its payer. No product interface calls it: a client that reaches
the route has built its own stop control, and the route and its authorization matrix
are what such a control gets. A stop saves and bills the partial it produced; one that
produced nothing commits nothing.

## Membership revalidation and eviction

Membership is revalidated at broadcast against a short-TTL Redis cache of authoritative
membership, with a database recheck on miss. Eviction fires on membership change, key
rotation, and session or link revocation: the identity slice's revocation paths (logout,
password change, recovery reset, account deletion) thread an eviction port that closes the
principal's live sockets, tracked through a per-user active-room set the room maintains
on socket open and close. Closing is the promptness layer; the broadcast-time recheck is
the correctness layer, so a missed close is bounded, never permanent. Redis down pauses
delivery beyond a bounded last-known-good window.

## Fallback transport

WebSocket upgrade failures are not measured, and no fallback transport exists. The
re-entry condition for one is in `docs/DECISIONS.md` §Excluded services.
