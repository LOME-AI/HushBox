import { createAuthClient } from 'better-auth/react';
import { redirect } from '@tanstack/react-router';
import { frontendEnvSchema } from '@lome-chat/shared';

const env = frontendEnvSchema.parse({
  VITE_API_URL: import.meta.env['VITE_API_URL'] as unknown,
});

export const authClient = createAuthClient({
  baseURL: env.VITE_API_URL,
});

export const { useSession, signIn, signUp, signOut } = authClient;

export async function requireAuth(): Promise<{
  user: { id: string; email: string };
  session: { id: string };
}> {
  const session = await authClient.getSession();
  if (!session.data) {
    // TanStack Router redirect is designed to be thrown
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect({ to: '/login' });
  }
  return session.data;
}
