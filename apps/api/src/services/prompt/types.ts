import type { CapabilityId } from '@hushbox/shared';
import type { AIMessage, ToolDefinition } from '../ai/index.js';

/**
 * Module that provides tool definitions for a capability.
 * System prompts are handled by buildSystemPrompt from @hushbox/shared.
 */
export interface ToolModule {
  id: string;
  capability: CapabilityId;
  getTools(): ToolDefinition[];
}

export interface PromptBuilderOptions {
  modelId: string;
  supportedCapabilities: CapabilityId[];
  chatHistory?: AIMessage[];
  customInstructions?: string;
}

export interface BuiltPrompt {
  systemPrompt: string;
  tools: ToolDefinition[];
}
