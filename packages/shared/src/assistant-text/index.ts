export {
  ASSISTANT_FRAMING_MAX_CHARS,
  parseAssistantMessage,
  serializeSegments,
} from './grammar.ts';
export { SEGMENT_KINDS, SEGMENT_SPECS } from './segments.ts';
export type {
  ContainerKind,
  ReasoningSegment,
  Segment,
  SegmentByKind,
  SegmentKind,
  SegmentSpec,
  SegmentSpecTable,
  TextSegment,
  WebSearchSegment,
} from './segments.ts';
export {
  createAssistantStream,
  reduceAssistantStream,
  serializeAssistantStream,
  settleAssistantStream,
} from './reducer.ts';
export type { AssistantStreamState, SerializedAssistantStream } from './reducer.ts';
export { assistantAnswerText, assistantHistoryText, webSearchRowsInOrder } from './projection.ts';
