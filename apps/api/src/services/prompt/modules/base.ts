import type { PromptModule } from '../types.js';

export const baseModule: PromptModule = {
  id: 'base',
  capability: null,

  getSystemPromptSection(): string {
    const isoDate = new Date().toISOString();
    const currentDate = isoDate.substring(0, isoDate.indexOf('T'));
    return `You are a helpful AI assistant powered by LOME-CHAT.
You provide accurate, helpful responses while being concise and clear.
Current date: ${currentDate}`;
  },

  getTools(): [] {
    return [];
  },
};
