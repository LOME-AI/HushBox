import type { CapabilityId } from '@lome-chat/shared';
import type { ChatMessage, ToolDefinition } from '../openrouter/types.js';

export interface PromptModule {
  id: string;

  /** Set to null for modules that are always included (like the base module) */
  capability: CapabilityId | null;

  getSystemPromptSection(): string;
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
