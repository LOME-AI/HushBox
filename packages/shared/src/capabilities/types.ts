export type CapabilityId = 'python-execution' | 'javascript-execution' | 'vision' | 'web-search';

export interface Capability {
  id: CapabilityId;
  name: string;
  description: string;

  /**
   * OpenRouter parameters required for this capability.
   * Capability is only available if all parameters are in the model's supported_parameters.
   */
  requiredParameters: string[];
}

export const CAPABILITIES: Record<CapabilityId, Capability> = {
  'python-execution': {
    id: 'python-execution',
    name: 'Python Execution',
    description: 'Run Python code in a secure sandbox',
    requiredParameters: ['tools'],
  },
  'javascript-execution': {
    id: 'javascript-execution',
    name: 'JavaScript Execution',
    description: 'Run JavaScript code in a secure sandbox',
    requiredParameters: ['tools'],
  },
  vision: {
    id: 'vision',
    name: 'Vision',
    description: 'Analyze and understand images',
    requiredParameters: [],
  },
  'web-search': {
    id: 'web-search',
    name: 'Web Search',
    description: 'Search the web for current information',
    requiredParameters: ['tools'],
  },
};

export const CAPABILITY_IDS = Object.keys(CAPABILITIES) as CapabilityId[];
