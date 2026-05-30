import { useMutation } from '@tanstack/react-query';
import { changePassword } from '@/lib/auth';

interface ChangePasswordVariables {
  currentPassword: string;
  newPassword: string;
}

interface ChangePasswordResult {
  success: boolean;
  error?: string;
}

/**
 * Wraps `changePassword` in a TanStack mutation so its in-flight state is
 * counted by `useIsMutating`. The settled-aware test harness reads that
 * counter to decide when the app has finished mutating — without this hook
 * the OPAQUE-plus-rewrap flow looks idle between its two fetches and the
 * settled signal fires before the modal can close.
 */
export function useChangePassword(): ReturnType<
  typeof useMutation<ChangePasswordResult, Error, ChangePasswordVariables>
> {
  return useMutation<ChangePasswordResult, Error, ChangePasswordVariables>({
    mutationFn: async ({ currentPassword, newPassword }) => {
      const result = await changePassword(currentPassword, newPassword);
      if (!result.success) {
        throw new Error(result.error ?? 'CHANGE_PASSWORD_FAILED');
      }
      return result;
    },
  });
}
