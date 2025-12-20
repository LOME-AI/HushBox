import { defineConfig } from 'drizzle-kit';

// Use MIGRATION_DATABASE_URL for local dev (TCP), fall back to DATABASE_URL for production
const connectionString = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('MIGRATION_DATABASE_URL or DATABASE_URL environment variable is required');
}

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: connectionString,
  },
});
