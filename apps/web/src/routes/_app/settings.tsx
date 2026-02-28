import * as React from 'react';
import { useState, useCallback } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle, CardDescription, Button } from '@hushbox/ui';
import { Shield, Key, FileText, Scale, ChevronRight } from 'lucide-react';
import { PRIVACY_POLICY_META } from '@hushbox/shared/legal';
import { requireAuth, changePassword, useAuthStore } from '@/lib/auth';
import { ROUTES } from '@hushbox/shared';
import { PageHeader } from '@/components/shared/page-header';
import { ThemeToggle } from '@/components/shared/theme-toggle';
import { ChangePasswordModal } from '@/components/auth/ChangePasswordModal';
import { TwoFactorSetup } from '@/components/auth/TwoFactorSetup';
import { DisableTwoFactorModal } from '@/components/auth/DisableTwoFactorModal';
import { RecoveryPhraseModal } from '@/components/auth/RecoveryPhraseModal';
import { RegenerateConfirmModal } from '@/components/auth/RegenerateConfirmModal';

export const Route = createFileRoute('/_app/settings')({
  beforeLoad: async () => {
    await requireAuth();
  },
  component: SettingsPage,
});

interface SettingItemProps {
  icon: React.ElementType;
  title: string;
  description: string;
  onClick: () => void;
  statusBadge?: React.ReactNode;
}

function SettingItem({
  icon: Icon,
  title,
  description,
  onClick,
  statusBadge,
}: Readonly<SettingItemProps>): React.JSX.Element {
  return (
    <Button
      variant="ghost"
      className="h-auto w-full justify-between gap-3 p-4 text-left whitespace-normal"
      onClick={onClick}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Icon className="text-muted-foreground h-4 w-4 shrink-0" />
          <span className="min-w-0 truncate font-medium">{title}</span>
          {statusBadge}
        </div>
        <p className="text-muted-foreground mt-0.5 text-sm">{description}</p>
      </div>
      <ChevronRight className="text-muted-foreground h-5 w-5 shrink-0" />
    </Button>
  );
}

function StatusBadge({
  label,
  variant,
}: Readonly<{ label: string; variant: 'green' | 'muted' | 'amber' }>): React.JSX.Element {
  const classes = {
    green: 'text-green-600 bg-green-50 dark:bg-green-950/30',
    muted: 'text-muted-foreground bg-muted',
    amber: 'text-amber-600 bg-amber-50 dark:bg-amber-950/30',
  };

  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${classes[variant]}`}>
      {label}
    </span>
  );
}

function TwoFactorSettingSection({
  totpEnabled,
}: Readonly<{ totpEnabled: boolean }>): React.JSX.Element {
  const [showTwoFactorSetup, setShowTwoFactorSetup] = useState(false);
  const [showDisable2FA, setShowDisable2FA] = useState(false);

  const handleTwoFactorSuccess = useCallback(() => {
    setShowTwoFactorSetup(false);
    const currentUser = useAuthStore.getState().user;
    if (currentUser) {
      useAuthStore.getState().setUser({ ...currentUser, totpEnabled: true });
    }
  }, []);

  const handleDisable2FASuccess = useCallback(() => {
    setShowDisable2FA(false);
    const currentUser = useAuthStore.getState().user;
    if (currentUser) {
      useAuthStore.getState().setUser({ ...currentUser, totpEnabled: false });
    }
  }, []);

  return (
    <>
      <SettingItem
        icon={Shield}
        title="Two-Factor Authentication"
        description={
          totpEnabled ? 'Manage your authentication security' : 'Add an extra layer of security'
        }
        onClick={() => {
          if (totpEnabled) {
            setShowDisable2FA(true);
          } else {
            setShowTwoFactorSetup(true);
          }
        }}
        statusBadge={
          totpEnabled ? (
            <StatusBadge label="Enabled" variant="green" />
          ) : (
            <StatusBadge label="Disabled" variant="muted" />
          )
        }
      />
      <TwoFactorSetup
        open={showTwoFactorSetup}
        onOpenChange={setShowTwoFactorSetup}
        onSuccess={handleTwoFactorSuccess}
      />
      <DisableTwoFactorModal
        open={showDisable2FA}
        onOpenChange={setShowDisable2FA}
        onSuccess={handleDisable2FASuccess}
      />
    </>
  );
}

export function SettingsPage(): React.JSX.Element {
  const user = useAuthStore((s) => s.user);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showRecoveryPhrase, setShowRecoveryPhrase] = useState(false);
  const [showRegenerateConfirm, setShowRegenerateConfirm] = useState(false);

  const handleChangePasswordSuccess = useCallback(() => {
    setShowChangePassword(false);
  }, []);

  const handleRecoverySuccess = useCallback(() => {
    setShowRecoveryPhrase(false);
    const currentUser = useAuthStore.getState().user;
    if (currentUser) {
      useAuthStore.getState().setUser({ ...currentUser, hasAcknowledgedPhrase: true });
    }
  }, []);

  const handleChangePasswordSubmit = useCallback(
    async (data: {
      currentPassword: string;
      newPassword: string;
    }): Promise<{ success: boolean; error?: string }> => {
      return changePassword(data.currentPassword, data.newPassword);
    },
    []
  );

  const handleRecoveryClick = useCallback(() => {
    if (user?.hasAcknowledgedPhrase) {
      setShowRegenerateConfirm(true);
    } else {
      setShowRecoveryPhrase(true);
    }
  }, [user?.hasAcknowledgedPhrase]);

  const handleConfirmRegenerate = useCallback(() => {
    setShowRegenerateConfirm(false);
    setShowRecoveryPhrase(true);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Settings" right={<ThemeToggle />} />

      <div className="container mx-auto max-w-4xl flex-1 space-y-6 overflow-y-auto p-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-[#ec4755]">Account</CardTitle>
            <CardDescription>Your account information</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 text-lg font-medium break-all">{user?.email}</p>
              {user?.emailVerified ? (
                <StatusBadge label="Verified" variant="green" />
              ) : (
                <StatusBadge label="Not verified" variant="amber" />
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-[#ec4755]">Security</CardTitle>
            <CardDescription>Manage authentication</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            <SettingItem
              icon={Key}
              title="Change Password"
              description="Update your account password"
              onClick={() => {
                setShowChangePassword(true);
              }}
            />
            <TwoFactorSettingSection totpEnabled={user?.totpEnabled ?? false} />
            <SettingItem
              icon={FileText}
              title="Recovery Phrase"
              description="Protect from forgetting your password"
              onClick={handleRecoveryClick}
              statusBadge={
                user?.hasAcknowledgedPhrase ? (
                  <StatusBadge label="Enabled" variant="green" />
                ) : (
                  <StatusBadge label="Disabled" variant="muted" />
                )
              }
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-[#ec4755]">Legal</CardTitle>
            <CardDescription>Terms and policies</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <a href={ROUTES.TERMS} className="flex items-center gap-3 text-sm hover:underline">
              <Scale className="h-4 w-4" />
              Terms of Service
            </a>
            <a href={ROUTES.PRIVACY} className="flex items-center gap-3 text-sm hover:underline">
              <Shield className="h-4 w-4" />
              Privacy Policy
            </a>
            <p className="text-muted-foreground text-xs">
              Effective: {PRIVACY_POLICY_META.effectiveDate}
            </p>
          </CardContent>
        </Card>
      </div>

      <RegenerateConfirmModal
        open={showRegenerateConfirm}
        onOpenChange={setShowRegenerateConfirm}
        onConfirm={handleConfirmRegenerate}
      />

      <ChangePasswordModal
        open={showChangePassword}
        onOpenChange={setShowChangePassword}
        onSuccess={handleChangePasswordSuccess}
        onSubmit={handleChangePasswordSubmit}
      />

      <RecoveryPhraseModal
        open={showRecoveryPhrase}
        onOpenChange={setShowRecoveryPhrase}
        onSuccess={handleRecoverySuccess}
      />
    </div>
  );
}
