import { Code, FileText, Lightbulb, MessageSquare, type LucideIcon } from 'lucide-react';

export interface PromptSuggestion {
  id: string;
  icon: LucideIcon;
  label: string;
  prompts: string[];
}

export const promptSuggestions: PromptSuggestion[] = [
  {
    id: 'code',
    icon: Code,
    label: 'Help me write code',
    prompts: [
      'Write a TypeScript function that takes an array of user objects with name and email fields, filters out users without valid email addresses, and returns the remaining users sorted alphabetically by name.',
      'Create a React custom hook called useDebounce that accepts a value and delay in milliseconds, and returns a debounced version of that value that only updates after the specified delay.',
      'Build a Python script that reads a CSV file containing sales data with columns for date, product, and amount, calculates the total revenue per product category, and exports the results to a new CSV file.',
      'Write a SQL query that finds all customers who have placed more than 3 orders in the last 30 days, including their total spend and average order value.',
      'Create a JavaScript function that takes a nested object of any depth and flattens it into a single-level object with dot-notation keys.',
      'Build a REST API endpoint in Node.js with Express that accepts a POST request with user registration data, validates the email and password, and returns appropriate success or error responses.',
      'Write a bash script that monitors a directory for new files, compresses any files larger than 10MB, and moves the originals to an archive folder.',
      'Create a React component that displays a paginated table of products with sorting by name, price, and date columns, and a search filter that updates the results in real-time.',
      'Write a Python function that connects to a PostgreSQL database, retrieves all orders from the last week, and generates a summary report with daily totals.',
      'Build a TypeScript utility that validates form data against a schema, returns detailed error messages for each invalid field, and supports nested object validation.',
      'Create a CSS animation that makes an element pulse with a glow effect, fading between two colors smoothly with a 2-second duration.',
      'Write a GitHub Actions workflow that runs tests on pull requests, checks code formatting, and deploys to staging when merged to the main branch.',
    ],
  },
  {
    id: 'explain',
    icon: FileText,
    label: 'Explain a concept',
    prompts: [
      'Explain how vaccines work to protect against diseases, including how they train the immune system to recognize and fight specific pathogens.',
      'Explain why the sky is blue during the day and turns orange and red during sunset, including the science behind light scattering.',
      'Explain how compound interest works and why starting to save early makes such a big difference for retirement.',
      'Explain what causes inflation and how it affects the purchasing power of money over time.',
      'Explain how habits form in the brain and what science says about the most effective ways to build new habits or break bad ones.',
      'Explain the difference between introversion and extroversion, and why these personality traits affect how people recharge their energy.',
      'Explain how black holes form and what happens to matter and light that gets too close to one.',
      'Explain what causes climate change and the main factors contributing to global temperature increases.',
      'Explain how credit scores work, what factors affect them, and why they matter for loans and financial decisions.',
      'Explain the placebo effect and why it sometimes works even when people know they are taking a placebo.',
      'Explain how the stock market works, including what it means to buy shares in a company and how stock prices are determined.',
      'Explain the difference between deductive and inductive reasoning, with examples of how each type of logic is used in everyday life.',
    ],
  },
  {
    id: 'brainstorm',
    icon: Lightbulb,
    label: 'Brainstorm ideas',
    prompts: [
      'Give me 10 creative date night ideas for couples who want to do something different from dinner and a movie, with options for different budgets.',
      'Brainstorm 8 thoughtful gift ideas for someone who says they do not want anything and already has everything they need.',
      'Come up with 10 ways to organize a small closet to maximize space and make it easier to find clothes in the morning.',
      'Generate 12 ideas for a memorable 50th birthday party that celebrates the guest of honor without being too over-the-top.',
      'Brainstorm 10 healthy meal prep ideas for busy weeknights that take less than 30 minutes and use simple ingredients.',
      'Come up with 8 creative ways to make exercise more enjoyable for someone who finds traditional workouts boring.',
      'Generate 10 ideas for starting a side project or hobby that could eventually turn into extra income.',
      'Brainstorm 8 ways to make a small apartment feel more spacious and organized without spending much money.',
      'Come up with 10 conversation starters for networking events that go beyond asking what someone does for work.',
      'Generate 12 ideas for family activities on a rainy weekend that do not involve screens and work for kids of different ages.',
      'Brainstorm 8 ways to reduce household expenses by $200-300 per month without drastically changing your lifestyle.',
      'Come up with 10 ideas for making long car trips more enjoyable for the whole family, including games and activities.',
    ],
  },
  {
    id: 'question',
    icon: MessageSquare,
    label: 'Answer a question',
    prompts: [
      'What is the best way to start learning a new language as an adult, and how long does it typically take to become conversational?',
      'What should I look for when buying a used car, and what are the red flags that indicate I should walk away?',
      'What are the most important things to know before buying a first home, including hidden costs that first-time buyers often overlook?',
      'What is the difference between a Roth IRA and a traditional IRA, and which one makes more sense for someone in their 30s?',
      'What are some effective strategies for dealing with work stress and preventing burnout while maintaining productivity?',
      'What should I consider when choosing between renting and buying a home in the current market?',
      'What are the key things to know about starting a small business, including the most common mistakes new entrepreneurs make?',
      'What is the best approach for having a difficult conversation with a family member about a sensitive topic?',
      'What should I pack for a two-week trip to Europe if I want to travel light with just a carry-on bag?',
      'What are the signs that it might be time to look for a new job, and how should I approach a job search while still employed?',
      'What are the pros and cons of different types of exercise like running, weightlifting, and yoga for overall health?',
      'What should I know about caring for aging parents, including resources available and how to have conversations about their future needs?',
    ],
  },
];
