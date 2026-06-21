import { useState, useCallback, useRef } from 'react';

interface UseOtpVerificationOptions {
  onVerify: (code: string) => Promise<{ success: boolean; error?: string }>;
  onSuccess: () => void;
}

interface UseOtpVerificationReturn {
  otpValue: string;
  setOtpValue: (value: string) => void;
  error: string | null;
  isVerifying: boolean;
  handleVerify: (codeOverride?: string) => void;
  handleComplete: (value: string) => void;
  reset: () => void;
}

export function useOtpVerification({
  onVerify,
  onSuccess,
}: UseOtpVerificationOptions): UseOtpVerificationReturn {
  const [otpValue, setOtpValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);

  // Stable refs to avoid stale closures when callbacks change
  const onVerifyRef = useRef(onVerify);
  onVerifyRef.current = onVerify;
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;

  const handleVerify = useCallback(
    (codeOverride?: string) => {
      const code = codeOverride ?? otpValue;
      if (code.length !== 6 || isVerifying) return;

      setIsVerifying(true);
      setError(null);

      void (async () => {
        try {
          const result = await onVerifyRef.current(code);

          if (result.success) {
            onSuccessRef.current();
          } else {
            setError(result.error ?? 'Verification failed');
            setOtpValue('');
          }
        } catch {
          setError('Verification failed. Please try again.');
          setOtpValue('');
        } finally {
          setIsVerifying(false);
        }
      })();
    },
    [otpValue, isVerifying]
  );

  const handleComplete = useCallback(
    (value: string) => {
      handleVerify(value);
    },
    [handleVerify]
  );

  const reset = useCallback(() => {
    setOtpValue('');
    setError(null);
    setIsVerifying(false);
  }, []);

  return {
    otpValue,
    setOtpValue,
    error,
    isVerifying,
    handleVerify,
    handleComplete,
    reset,
  };
}
