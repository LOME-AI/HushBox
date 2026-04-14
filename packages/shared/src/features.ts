export interface Feature {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly emoji: string;
  readonly lucideIcon: string;
}

export interface PlannedFeature {
  readonly id: string;
  readonly name: string;
  readonly emoji: string;
  readonly lucideIcon: string;
}

export const SHIPPED_FEATURES: readonly Feature[] = [
  { id: 'multi-model-chat', name: 'Multi-Model Chat', description: 'Access GPT, Claude, Gemini, and dozens more from one place.', emoji: '💬', lucideIcon: 'MessagesSquare' },
  { id: 'model-switching', name: 'Model Switching', description: 'Change models mid-conversation. Compare outputs side by side.', emoji: '🔀', lucideIcon: 'ArrowLeftRight' },
  { id: 'document-panel', name: 'Document Panel', description: 'Code editing, rendering, and word processing in one unified panel.', emoji: '📄', lucideIcon: 'FileCode2' },
  { id: 'group-chats', name: 'Group Chats', description: 'Collaborate with others in real-time encrypted conversations.', emoji: '👥', lucideIcon: 'Users' },
  { id: 'two-factor-auth', name: 'Two-Factor Auth', description: 'TOTP-based 2FA for an extra layer of account security.', emoji: '🔐', lucideIcon: 'ShieldCheck' },
  { id: 'recovery-phrase', name: 'Recovery Phrase', description: '12-word mnemonic backup so you never lose access to your encrypted data.', emoji: '🔑', lucideIcon: 'KeyRound' },
  { id: 'smart-model-select', name: 'Smart Model Select', description: 'Auto-picks the best model for your task.', emoji: '⚡', lucideIcon: 'Sparkles' },
  { id: 'web-search', name: 'Web Search', description: 'Ground AI responses with real-time web results.', emoji: '🔍', lucideIcon: 'Globe' },
  { id: 'custom-instructions', name: 'Custom Instructions', description: 'Set persistent instructions that apply across all chats.', emoji: '⚙️', lucideIcon: 'Settings' },
  { id: 'chat-sharing', name: 'Chat Sharing + Sync', description: 'Share conversations and sync across all your devices.', emoji: '🔗', lucideIcon: 'Share2' },
  { id: 'forking', name: 'Conversation Forking', description: 'Branch conversations to explore different directions.', emoji: '🌿', lucideIcon: 'GitBranch' },
  { id: 'multi-model-response', name: 'Multi-Model Responses', description: 'Get answers from multiple models at once and compare.', emoji: '⚖️', lucideIcon: 'Layers' },
] as const;

export const COMING_SOON_FEATURES: readonly PlannedFeature[] = [
  { id: 'code-execution', name: 'Code Execution', emoji: '▶️', lucideIcon: 'Play' },
  { id: 'projects', name: 'Projects', emoji: '📁', lucideIcon: 'FolderOpen' },
  { id: 'custom-bots', name: 'Custom Bots', emoji: '🤖', lucideIcon: 'Bot' },
  { id: 'memory', name: 'Memory', emoji: '🧠', lucideIcon: 'Brain' },
  { id: 'file-handling', name: 'File Handling', emoji: '📎', lucideIcon: 'Paperclip' },
  { id: 'image-generation', name: 'Image Generation', emoji: '🖼️', lucideIcon: 'Image' },
  { id: 'audio-generation', name: 'Audio Generation', emoji: '🎵', lucideIcon: 'Music' },
  { id: 'video-generation', name: 'Video Generation', emoji: '🎬', lucideIcon: 'Video' },
] as const;
