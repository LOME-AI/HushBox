/**
 * Single source of truth for the idle-keepalive heartbeat wire payloads.
 *
 * The client (apps/web ws-client) sends {@link WS_HEARTBEAT_PING_MESSAGE} on
 * each heartbeat tick and compares inbound frames against
 * {@link WS_HEARTBEAT_PONG_MESSAGE}; the Durable Object (packages/realtime
 * conversation-room) registers the same pair via
 * `setWebSocketAutoResponse(new WebSocketRequestResponsePair(ping, pong))`.
 *
 * The Workers runtime matches the registered ping string EXACTLY (byte-for-byte)
 * to short-circuit the response without waking the DO, so the string the client
 * sends, the string it compares against, and the pair the DO registers must be
 * identical. Defining them here once makes that byte-equality structural rather
 * than a comment-enforced convention across two packages.
 */
export const WS_HEARTBEAT_PING_MESSAGE = '{"type":"ping"}';
export const WS_HEARTBEAT_PONG_MESSAGE = '{"type":"pong"}';
