import * as React from 'react';
import { useState, useCallback, useEffect, useRef } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Button } from '@hushbox/ui/button';
import { AlertTriangle, Check, Icon, Shield } from '@hushbox/ui/icons';
import { ROUTES, TEST_IDS } from '@hushbox/shared';
import { requireAuth, useAuthStore, selectInstructionsReadUnresolved } from '@/lib/auth/auth';
import { useChangePassword } from '@/hooks/auth/auth-mutations';
import { SETTINGS_SECTION_IDS, useSectionInView } from '@/hooks/ui/use-section-in-view';
import { openExternalPage } from '@/capacitor';
import { PageHeader } from '@/components/shared/page-header';
import { PageBody } from '@/components/shared/page-body';
import { ChangePasswordModal } from '@/components/auth/change-password-modal';
import { TwoFactorSetup } from '@/components/auth/two-factor-setup';
import { DisableTwoFactorModal } from '@/components/auth/disable-two-factor-modal';
import { RecoveryPhraseModal } from '@/components/auth/recovery-phrase-modal';
import { RegenerateConfirmModal } from '@/components/auth/regenerate-confirm-modal';
import { AccountNav } from '@/components/settings/account-nav';
import { CustomInstructionsModal } from '@/components/settings/custom-instructions-modal';
import { DeleteAccountModal } from '@/components/settings/delete-account-modal';
import { MailingListRow } from '@/components/settings/mailing-list-row';
import { NotificationsSettings } from '@/components/settings/notifications-settings';
import { SettingsGroup } from '@/components/settings/settings-group';
import { SettingsRow } from '@/components/settings/settings-row';
import { SettingsStatusBadge } from '@/components/settings/settings-status-badge';

export const Route = createFileRoute('/_app/settings')({
  beforeLoad: async () => {
    await requireAuth();
  },
  component: SettingsPage,
});

/**
 * The custom-instruction badge. A `null` value means BOTH "this account stores
 * none" and "the read that would say has not landed", so the read's status is
 * asked first: a value-only badge tells a member with a stored instruction that
 * they have none for as long as their read is outstanding.
 */
function instructionsBadge(
  isReadUnresolved: boolean,
  instructions: string | null
): React.JSX.Element {
  if (isReadUnresolved) {
    return <SettingsStatusBadge status="Loading..." />;
  }
  if (instructions == null) {
    return <SettingsStatusBadge status="Not set" />;
  }
  return <SettingsStatusBadge status="Active" />;
}

/**
 * The Security group's two-factor row. The page holds the setup's open state, so the row and
 * the Needs attention group open the one setup.
 */
function TwoFactorSettingSection({
  totpEnabled,
  showTwoFactorSetup,
  setShowTwoFactorSetup,
  onTwoFactorSuccess,
  rowRef,
}: Readonly<{
  totpEnabled: boolean;
  showTwoFactorSetup: boolean;
  setShowTwoFactorSetup: (open: boolean) => void;
  onTwoFactorSuccess: () => void;
  rowRef: React.Ref<HTMLButtonElement>;
}>): React.JSX.Element {
  const [showDisable2FA, setShowDisable2FA] = useState(false);

  const handleDisable2FASuccess = useCallback(() => {
    setShowDisable2FA(false);
    const currentUser = useAuthStore.getState().user;
    if (currentUser) {
      useAuthStore.getState().setUser({ ...currentUser, totpEnabled: false });
    }
  }, []);

  return (
    <>
      <SettingsRow
        ref={rowRef}
        kind="navigate"
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
        badge={<SettingsStatusBadge status={totpEnabled ? 'Enabled' : 'Disabled'} />}
      />
      <TwoFactorSetup
        open={showTwoFactorSetup}
        onOpenChange={setShowTwoFactorSetup}
        onSuccess={onTwoFactorSuccess}
      />
      <DisableTwoFactorModal
        open={showDisable2FA}
        onOpenChange={setShowDisable2FA}
        onSuccess={handleDisable2FASuccess}
      />
    </>
  );
}

/**
 * Lands focus once a flow the Needs attention group started completes. Completing it removes
 * the group's row, which opened the dialog, so the dialog has nowhere to return focus; focus
 * goes to the Security row that reads the new status instead. A flow closed unfinished keeps
 * its row, and the dialog returns focus there. Returns the mark the group's control sets.
 */
function useLandingAfterGroupFlow(
  open: boolean,
  done: boolean,
  row: React.RefObject<HTMLButtonElement | null>
): () => void {
  const fromGroup = useRef(false);
  useEffect(() => {
    if (open || !fromGroup.current) return;
    fromGroup.current = false;
    // The dialog's own focus return acts only while focus sits on the body, so it keeps this.
    if (done) row.current?.focus();
  }, [open, done, row]);
  return useCallback(() => {
    fromGroup.current = true;
  }, []);
}

interface GroupFlowLandings {
  user: { hasAcknowledgedPhrase: boolean; totpEnabled: boolean } | null;
  twoFactorOpen: boolean;
  recoveryOpen: boolean;
  twoFactorRow: React.RefObject<HTMLButtonElement | null>;
  recoveryRow: React.RefObject<HTMLButtonElement | null>;
}

/** The two Needs attention flows' landings, on the Security rows that read their status. */
function useGroupFlowLandings({
  user,
  twoFactorOpen,
  recoveryOpen,
  twoFactorRow,
  recoveryRow,
}: Readonly<GroupFlowLandings>): { markTwoFactor: () => void; markRecovery: () => void } {
  const markTwoFactor = useLandingAfterGroupFlow(
    twoFactorOpen,
    user?.totpEnabled === true,
    twoFactorRow
  );
  const markRecovery = useLandingAfterGroupFlow(
    recoveryOpen,
    user?.hasAcknowledgedPhrase === true,
    recoveryRow
  );
  return { markTwoFactor, markRecovery };
}

interface NeedsAttentionGroupProps {
  user: { hasAcknowledgedPhrase: boolean; totpEnabled: boolean } | null;
  onSavePhrase: () => void;
  onTurnOnTwoFactor: () => void;
}

/** The account gaps that open the page: an unsaved recovery phrase, and two-factor off. */
function NeedsAttentionGroup({
  user,
  onSavePhrase,
  onTurnOnTwoFactor,
}: Readonly<NeedsAttentionGroupProps>): React.JSX.Element | null {
  const phraseUnsaved = user?.hasAcknowledgedPhrase === false;
  const twoFactorOff = user?.totpEnabled === false;
  if (!phraseUnsaved && !twoFactorOff) return null;
  return (
    <div data-testid={TEST_IDS.needsAttention}>
      <SettingsGroup id="needs-attention" title="Needs attention" tone="attention">
        {phraseUnsaved ? (
          <SettingsRow
            kind="action"
            inline
            icon={<Icon icon={AlertTriangle} className="text-warning" />}
            title="Recovery phrase not saved"
            description="If you lose your password, this is your only recovery."
            action={
              <Button block onClick={onSavePhrase}>
                Save phrase
              </Button>
            }
          />
        ) : null}
        {twoFactorOff ? (
          <SettingsRow
            kind="action"
            inline
            icon={<Icon icon={Shield} className="text-warning" />}
            title="Two-factor authentication is off"
            description="A stolen password alone could open your account."
            action={
              <Button block onClick={onTurnOnTwoFactor}>
                Turn on
              </Button>
            }
          />
        ) : null}
      </SettingsGroup>
    </div>
  );
}

function SettingsPage(): React.JSX.Element {
  const currentSection = useSectionInView(SETTINGS_SECTION_IDS);
  const user = useAuthStore((s) => s.user);
  const customInstructions = useAuthStore((s) => s.customInstructions);
  const isInstructionsReadUnresolved = useAuthStore(selectInstructionsReadUnresolved);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showRecoveryPhrase, setShowRecoveryPhrase] = useState(false);
  const [showRegenerateConfirm, setShowRegenerateConfirm] = useState(false);
  const [showCustomInstructions, setShowCustomInstructions] = useState(false);
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  const [showTwoFactorSetup, setShowTwoFactorSetup] = useState(false);
  const twoFactorRowRef = useRef<HTMLButtonElement>(null);
  const recoveryRowRef = useRef<HTMLButtonElement>(null);
  const { markTwoFactor, markRecovery } = useGroupFlowLandings({
    user,
    twoFactorOpen: showTwoFactorSetup,
    recoveryOpen: showRecoveryPhrase,
    twoFactorRow: twoFactorRowRef,
    recoveryRow: recoveryRowRef,
  });

  const handleTwoFactorSuccess = useCallback(() => {
    setShowTwoFactorSetup(false);
    const currentUser = useAuthStore.getState().user;
    if (currentUser) {
      useAuthStore.getState().setUser({ ...currentUser, totpEnabled: true });
    }
  }, []);

  const handleCustomInstructionsSuccess = useCallback(() => {
    setShowCustomInstructions(false);
  }, []);

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

  const changePasswordMutation = useChangePassword();
  const handleChangePasswordSubmit = useCallback(
    async (data: {
      currentPassword: string;
      newPassword: string;
    }): Promise<{ success: boolean; error?: string }> => {
      try {
        await changePasswordMutation.mutateAsync(data);
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : undefined;
        return { success: false, ...(message !== undefined && { error: message }) };
      }
    },
    [changePasswordMutation]
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
      <PageHeader title="Settings" />

      <PageBody
        testId={TEST_IDS.settingsContent}
        pinned={<AccountNav current={currentSection} />}
        className="flex flex-col gap-9 pt-6 pb-16"
      >
        <NeedsAttentionGroup
          user={user}
          onSavePhrase={() => {
            markRecovery();
            handleRecoveryClick();
          }}
          onTurnOnTwoFactor={() => {
            markTwoFactor();
            setShowTwoFactorSetup(true);
          }}
        />

        <SettingsGroup id="account" title="Account">
          <SettingsRow
            kind="value"
            title="Email"
            description={<span className="break-all">{user?.email}</span>}
            value={
              user?.emailVerified ? (
                <SettingsStatusBadge status="Verified" icon={Check} />
              ) : (
                <SettingsStatusBadge status="Not verified" />
              )
            }
          />
          <SettingsRow
            kind="value"
            title="Username"
            value={
              // Capped by the settings list, its size container, so a long name wraps beside its
              // title under the widget's largest text rather than running over it.
              <span className="text-ui inline-block max-w-[45cqw] text-right wrap-anywhere">
                {user?.username}
              </span>
            }
          />
        </SettingsGroup>

        <SettingsGroup id="security" title="Security">
          <SettingsRow
            kind="navigate"
            title="Change Password"
            description="Update your account password"
            onClick={() => {
              setShowChangePassword(true);
            }}
          />
          <TwoFactorSettingSection
            totpEnabled={user?.totpEnabled ?? false}
            showTwoFactorSetup={showTwoFactorSetup}
            setShowTwoFactorSetup={setShowTwoFactorSetup}
            onTwoFactorSuccess={handleTwoFactorSuccess}
            rowRef={twoFactorRowRef}
          />
          <SettingsRow
            ref={recoveryRowRef}
            kind="navigate"
            title="Recovery Phrase"
            description="Protect from forgetting your password"
            onClick={handleRecoveryClick}
            badge={
              <SettingsStatusBadge status={user?.hasAcknowledgedPhrase ? 'Enabled' : 'Disabled'} />
            }
          />
        </SettingsGroup>

        <SettingsGroup id="preferences" title="Preferences">
          <SettingsRow
            kind="navigate"
            title="Custom Instructions"
            description="Tell the AI about yourself and how you'd like it to respond"
            onClick={() => {
              setShowCustomInstructions(true);
            }}
            badge={instructionsBadge(isInstructionsReadUnresolved, customInstructions)}
          />
          <MailingListRow />
        </SettingsGroup>

        <NotificationsSettings />

        <SettingsGroup id="legal" title="Legal">
          <SettingsRow
            kind="link"
            title="Terms of Service"
            external
            onOpen={() => void openExternalPage(ROUTES.TERMS)}
          />
          <SettingsRow
            kind="link"
            title="Privacy Policy"
            external
            onOpen={() => void openExternalPage(ROUTES.PRIVACY)}
          />
        </SettingsGroup>

        <SettingsGroup id="danger" title="Danger zone" tone="danger">
          <SettingsRow
            kind="action"
            description="Permanently delete your account and all associated data."
            action={
              <Button
                variant="destructive"
                block
                onClick={() => {
                  setShowDeleteAccount(true);
                }}
                data-testid={TEST_IDS.deleteAccountTrigger}
              >
                Delete Account
              </Button>
            }
          />
        </SettingsGroup>
      </PageBody>

      <DeleteAccountModal open={showDeleteAccount} onOpenChange={setShowDeleteAccount} />

      <CustomInstructionsModal
        open={showCustomInstructions}
        onOpenChange={setShowCustomInstructions}
        onSuccess={handleCustomInstructionsSuccess}
      />

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
