import { customType } from 'drizzle-orm/pg-core';

export const bytea = customType<{ data: Uint8Array; driverData: string }>({
  dataType() {
    return 'bytea';
  },
  toDriver(value: Uint8Array): string {
    return String.raw`\x` + Buffer.from(value).toString('hex');
  },
  fromDriver(value: unknown): Uint8Array {
    if (value instanceof Buffer) return new Uint8Array(value);
    if (typeof value === 'string') {
      const hex = value.startsWith(String.raw`\x`) ? value.slice(2) : value;
      return new Uint8Array(Buffer.from(hex, 'hex'));
    }
    return new Uint8Array(value as Buffer);
  },
});
