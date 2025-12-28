import type { CapabilityId } from '@lome-chat/shared';
import { baseModule } from './modules/base.js';
import { pythonModule } from './modules/python.js';
import { javascriptModule } from './modules/javascript.js';
import type { PromptModule, PromptBuilderOptions, BuiltPrompt } from './types.js';

const ALL_MODULES: PromptModule[] = [baseModule, pythonModule, javascriptModule];

export function buildPrompt(options: PromptBuilderOptions): BuiltPrompt {
  const capabilitySet = new Set<CapabilityId>(options.supportedCapabilities);

  const activeModules = ALL_MODULES.filter(
    (m) => m.capability === null || capabilitySet.has(m.capability)
  );

  const systemPrompt = activeModules.map((m) => m.getSystemPromptSection()).join('\n\n');
  const tools = activeModules.flatMap((m) => m.getTools());

  return { systemPrompt, tools };
}
