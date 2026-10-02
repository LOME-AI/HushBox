import { a } from './cycle-a.js';

export const b = (): string => (a as unknown as () => string)();
