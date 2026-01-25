import type { CapabilityId } from '../capabilities/types.js';

/**
 * Builds the system prompt based on active capabilities.
 * Mirrors the prompt building logic from the API for token estimation.
 */
export function buildSystemPrompt(capabilities: CapabilityId[]): string {
  const sections: string[] = [];

  // Base module (always included)
  const isoDate = new Date().toISOString();
  const currentDate = isoDate.slice(0, Math.max(0, isoDate.indexOf('T')));
  sections.push(`You are a helpful AI assistant powered by LOME-CHAT.
You provide accurate, helpful responses while being concise and clear.
Current date: ${currentDate}`);

  // Capability modules
  if (capabilities.includes('python-execution')) {
    sections.push(`## Python Code Execution
You can execute Python code using the execute_python tool.
- Use this for calculations, data processing, file operations
- Libraries available: numpy, pandas, matplotlib, requests
- Output is captured from stdout and returned to you
- Execution timeout: 30 seconds`);
  }

  if (capabilities.includes('javascript-execution')) {
    sections.push(`## JavaScript Code Execution
You can execute JavaScript code using the execute_javascript tool.
- Use this for calculations, data transformations, JSON processing
- Runs in Node.js environment
- Output is captured from console.log and returned to you
- Execution timeout: 30 seconds`);
  }

  return sections.join('\n\n');
}
