import type { ToolDefinition } from '../../openrouter/types.js';
import type { PromptModule } from '../types.js';

export const pythonModule: PromptModule = {
  id: 'python-execution',
  capability: 'python-execution',

  getSystemPromptSection(): string {
    return `
## Python Code Execution
You can execute Python code using the execute_python tool.
- Use this for calculations, data processing, file operations
- Libraries available: numpy, pandas, matplotlib, requests
- Output is captured from stdout and returned to you
- Execution timeout: 30 seconds`;
  },

  getTools(): ToolDefinition[] {
    return [
      {
        type: 'function',
        function: {
          name: 'execute_python',
          description: 'Execute Python code in a secure sandbox',
          parameters: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                description: 'Python code to execute',
              },
            },
            required: ['code'],
          },
        },
      },
    ];
  },
};
