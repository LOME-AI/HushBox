/** The space between a reply's head and its answer, wherever a reply is drawn. */
export const REPLY_HEAD_GAP_CLASS = 'mb-2.5';

/**
 * A reply's answer region. Clips only sideways, so the ring of a first block's
 * toggle keeps its top edge, and the side padding (offset by the negative margin,
 * so the text does not move) is the room for its left and right edges. The flow
 * root keeps the block formatting context `overflow-hidden` gave.
 */
export const REPLY_ANSWER_REGION_CLASS =
  '-mx-1 flow-root w-[calc(100%+0.5rem)] overflow-x-clip px-1 text-base leading-relaxed break-words';
