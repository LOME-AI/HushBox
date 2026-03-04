// Type augmentation for import.meta properties available in Node.js 21.2+
// Needed because the ambient @types/node version may not include these
interface ImportMeta {
  readonly dirname: string;
  readonly filename: string;
}
