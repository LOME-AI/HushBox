import type { ToolDefinition } from '../../openrouter/types.js';
import type { PromptModule } from '../types.js';

export const javascriptModule: PromptModule = {
  id: 'javascript-execution',
  capability: 'javascript-execution',

  getSystemPromptSection(): string {
    return `
## JavaScript Code Execution
You can execute JavaScript code using the execute_javascript tool.
- Use this for calculations, data transformations, JSON processing
- Runs in Node.js environment
- Output is captured from console.log and returned to you
- Execution timeout: 30 seconds`;
  },

  getTools(): ToolDefinition[] {
    return [
      {
        type: 'function',
        function: {
          name: 'execute_javascript',
          description: 'Execute JavaScript code in a secure sandbox',
          parameters: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                description: 'JavaScript code to execute',
              },
            },
            required: ['code'],
          },
        },
      },
    ];
  },
};
