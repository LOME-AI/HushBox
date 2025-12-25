import { Code, FileText, Lightbulb, MessageSquare, type LucideIcon } from 'lucide-react';

export interface PromptSuggestion {
  id: string;
  icon: LucideIcon;
  label: string;
  prompt: string;
}

export const promptSuggestions: PromptSuggestion[] = [
  {
    id: 'code',
    icon: Code,
    label: 'Help me write code',
    prompt: 'Help me write a function that...',
  },
  {
    id: 'explain',
    icon: FileText,
    label: 'Explain a concept',
    prompt: 'Explain how...',
  },
  {
    id: 'brainstorm',
    icon: Lightbulb,
    label: 'Brainstorm ideas',
    prompt: 'Give me ideas for...',
  },
  {
    id: 'question',
    icon: MessageSquare,
    label: 'Answer a question',
    prompt: 'What is...',
  },
];
