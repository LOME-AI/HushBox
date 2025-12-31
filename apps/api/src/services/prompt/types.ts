import type { CapabilityId } from '@lome-chat/shared';
import type { ChatMessage, ToolDefinition } from '../openrouter/types.js';

/**
 * Module that provides tool definitions for a capability.
 * System prompts are handled by buildSystemPrompt from @lome-chat/shared.
 */
export interface ToolModule {
  id: string;
  capability: CapabilityId;
  getTools(): ToolDefinition[];
}

export interface PromptBuilderOptions {
  modelId: string;
  supportedCapabilities: CapabilityId[];
  chatHistory?: ChatMessage[];
}

export interface BuiltPrompt {
  systemPrompt: string;
  tools: ToolDefinition[];
}
