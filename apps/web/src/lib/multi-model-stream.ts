import type { StartEventData } from './sse-client';
import { createAssistantMessage } from './chat-messages';
import type { Message } from './api';

export interface ProcessStartEventResult {
  modelMap: Map<string, string>;
  messages: Message[];
  assistantMessageIds: string[];
}

/** Build model→message map and create assistant messages from a stream start event. */
export function processStartEvent(
  data: StartEventData,
  conversationId: string,
  parentMessageId: string | null
): ProcessStartEventResult {
  const modelMap = new Map<string, string>();
  const messages = data.models.map((entry) => {
    modelMap.set(entry.modelId, entry.assistantMessageId);
    return createAssistantMessage(
      conversationId,
      entry.assistantMessageId,
      entry.modelId,
      parentMessageId
    );
  });
  return {
    modelMap,
    messages,
    assistantMessageIds: data.models.map((entry) => entry.assistantMessageId),
  };
}
