import { describe, it, expect, expectTypeOf } from 'vitest';
import { TRIAL_REMAINING_MESSAGE_ID } from '../affordability/notices.ts';
import { MEMBER_PRIVILEGES } from '../enums/member-privilege.ts';
import { TEST_IDS, TEST_ID_BUILDERS } from './test-ids.ts';
import type { ComposerNoticeId } from '../affordability/notices.ts';

describe('TEST_IDS', () => {
  const entries = Object.entries(TEST_IDS);
  const values = Object.values(TEST_IDS);

  it('is a non-empty registry of static test ids', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it('has every value as a non-empty string', () => {
    for (const [key, value] of entries) {
      expect(typeof value, `TEST_IDS.${key} is not a string`).toBe('string');
      expect(value.length, `TEST_IDS.${key} is empty`).toBeGreaterThan(0);
    }
  });

  it('has every value in kebab-case', () => {
    for (const [key, value] of entries) {
      expect(value, `TEST_IDS.${key} = "${value}" is not kebab-case`).toMatch(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/
      );
    }
  });

  it('has every key in camelCase', () => {
    for (const key of Object.keys(TEST_IDS)) {
      expect(key, `TEST_IDS key "${key}" is not camelCase`).toMatch(/^[a-z][a-zA-Z0-9]*$/);
    }
  });

  it('has no duplicate values', () => {
    const unique = new Set(values);
    expect(unique.size, 'TEST_IDS has duplicate values').toBe(values.length);
  });

  it('exposes the announcement banner ids the e2e suite locates', () => {
    expect(values).toContain('announcement-banner');
    expect(values).toContain('announcement-banner-message');
    expect(values).toContain('announcement-banner-dismiss');
  });

  it('exposes the epoch integrity banner and invalid-keys placeholder ids', () => {
    expect(TEST_IDS).toMatchObject({
      epochIntegrityBanner: 'epoch-integrity-banner',
      messageInvalidKeys: 'message-invalid-keys',
    });
  });

  it('exposes the feedback expandable-row ids the admin app and e2e suite locate', () => {
    expect(values).toContain('admin-feedback-expand');
    expect(values).toContain('admin-feedback-detail');
  });

  it('exposes the demo-harness ids the demo modules assign imperatively', () => {
    expect(values).toContain('demo-signup-nudge');
    expect(values).toContain('demo-composer-cues');
  });

  it('exposes the newsletter signup, settings-toggle, and admin-screen ids', () => {
    expect(values).toContain('newsletter-signup-input');
    expect(values).toContain('newsletter-signup-submit');
    expect(values).toContain('settings-mailing-list-toggle');
    expect(values).toContain('admin-newsletter-table');
    expect(values).toContain('admin-newsletter-schedule');
    expect(values).toContain('admin-newsletter-subscribers');
  });

  it('exposes the shell ids the sidebar, header, overlays and palette carry', () => {
    expect(TEST_IDS).toMatchObject({
      newChatRow: 'new-chat-row',
      sidebarSearchRow: 'sidebar-search-row',
      accountButton: 'account-button',
      moreOptionsButton: 'more-options-button',
      moreOptionsMenu: 'more-options-menu',
      moreOptionsAccessibility: 'more-options-accessibility',
      accessibilityPanel: 'accessibility-panel',
      accessibilityPanelClose: 'accessibility-panel-close',
      rightPane: 'right-pane',
      commandPalette: 'command-palette',
      commandPaletteInput: 'command-palette-input',
      commandPaletteOption: 'command-palette-option',
      headerNewChat: 'header-new-chat',
    });
  });

  it('exposes the chat ids the welcome page, composer and replies carry', () => {
    expect(TEST_IDS).toMatchObject({
      modelInfo: 'model-info',
      continueList: 'continue-list',
      storageLine: 'storage-line',
      modeMenuButton: 'mode-menu-button',
      searchChip: 'search-chip',
      ratioChip: 'ratio-chip',
      ratioPopover: 'ratio-popover',
      ratioMoreButton: 'ratio-more-button',
      mediaEstimate: 'media-estimate',
      replyFooter: 'reply-footer',
      costBreakdown: 'cost-breakdown',
      replyDate: 'reply-date',
      effortTag: 'effort-tag',
      branchSwitcher: 'branch-switcher',
      branchSwitcherMenu: 'branch-switcher-menu',
      backToMain: 'back-to-main',
      forkMark: 'fork-mark',
      compareGroup: 'compare-group',
      continueWithModel: 'continue-with-model',
      compareSummary: 'compare-summary',
      diagramCard: 'diagram-card',
      diagramSourceToggle: 'diagram-source-toggle',
      sandboxBadge: 'sandbox-badge',
      documentOutputCodeToggle: 'document-output-code-toggle',
      assistantReplyView: 'assistant-reply-view',
    });
  });

  it('exposes the account and auth ids', () => {
    expect(TEST_IDS).toMatchObject({
      settingsSectionNav: 'settings-section-nav',
      needsAttention: 'needs-attention',
      balanceAdded: 'balance-added',
      returnToAppLink: 'return-to-app-link',
      usageSummary: 'usage-summary',
      usageTotalSpent: 'usage-total-spent',
      topConversations: 'top-conversations',
      accessibilityPreview: 'accessibility-preview',
      twoFactorLoginStep: 'two-factor-login-step',
    });
  });

  it('exposes the group, share and notice ids', () => {
    expect(TEST_IDS).toMatchObject({
      memberStrip: 'member-strip',
      memberFundedNames: 'member-funded-names',
      budgetZeroNote: 'budget-zero-note',
      shareHead: 'share-head',
      guestBar: 'guest-bar',
      guestBarSignUp: 'guest-bar-sign-up',
      sharedReplyNote: 'shared-reply-note',
      turnNoticeTile: 'turn-notice-tile',
    });
  });
});

describe('TEST_ID_BUILDERS', () => {
  it('builds member-scoped ids from a member id', () => {
    expect(TEST_ID_BUILDERS.memberItem('abc')).toBe('member-item-abc');
    expect(TEST_ID_BUILDERS.memberActions('abc')).toBe('member-actions-abc');
    expect(TEST_ID_BUILDERS.memberAvatar('abc')).toBe('member-avatar-abc');
    expect(TEST_ID_BUILDERS.memberChangePrivilege('abc')).toBe('member-change-privilege-abc');
    expect(TEST_ID_BUILDERS.memberRemoveAction('abc')).toBe('member-remove-action-abc');
    expect(TEST_ID_BUILDERS.memberOnline('abc')).toBe('member-online-abc');
  });

  it('builds an online indicator id from an entity id and prefix', () => {
    expect(TEST_ID_BUILDERS.onlineFor('member', 'm1')).toBe('member-online-m1');
    expect(TEST_ID_BUILDERS.onlineFor('member-avatar', 'm1')).toBe('member-avatar-online-m1');
  });

  it('builds a member section id from a privilege', () => {
    expect(TEST_ID_BUILDERS.memberSection('write')).toBe('member-section-write');
  });

  it('builds a privilege option id from a member id and privilege', () => {
    expect(TEST_ID_BUILDERS.privilegeOption('m1', 'admin')).toBe('privilege-option-m1-admin');
  });

  it('builds link-scoped ids from a link id', () => {
    expect(TEST_ID_BUILDERS.linkItem('l1')).toBe('link-item-l1');
    expect(TEST_ID_BUILDERS.linkActions('l1')).toBe('link-actions-l1');
    expect(TEST_ID_BUILDERS.linkNameInput('l1')).toBe('link-name-input-l1');
    expect(TEST_ID_BUILDERS.linkChangeName('l1')).toBe('link-change-name-l1');
    expect(TEST_ID_BUILDERS.linkChangePrivilege('l1')).toBe('link-change-privilege-l1');
    expect(TEST_ID_BUILDERS.linkRevokeAction('l1')).toBe('link-revoke-action-l1');
  });

  it('builds a link privilege option id from a link id and privilege', () => {
    expect(TEST_ID_BUILDERS.linkPrivilegeOption('l1', 'write')).toBe(
      'link-privilege-option-l1-write'
    );
  });

  it('builds a model item id from a model id', () => {
    expect(TEST_ID_BUILDERS.modelItem('openai/gpt-4o')).toBe('model-item-openai/gpt-4o');
  });

  it('builds fee item ids from a fee category id', () => {
    expect(TEST_ID_BUILDERS.feeItem('payment-processing')).toBe('item-fee-payment-processing');
    expect(TEST_ID_BUILDERS.feeItemPct('payment-processing')).toBe(
      'item-fee-payment-processing-pct'
    );
  });

  it('builds budget-scoped ids from a member id', () => {
    expect(TEST_ID_BUILDERS.budgetMember('m1')).toBe('budget-member-m1');
    expect(TEST_ID_BUILDERS.budgetInput('m1')).toBe('budget-input-m1');
    expect(TEST_ID_BUILDERS.budgetValue('m1')).toBe('budget-value-m1');
  });

  it('builds budget message ids from an error id', () => {
    expect(TEST_ID_BUILDERS.budgetMessage('trial_preview_pays')).toBe(
      'budget-message-trial_preview_pays'
    );
    expect(TEST_ID_BUILDERS.budgetMessageIcon('trial_preview_pays')).toBe(
      'budget-message-icon-trial_preview_pays'
    );
    expect(TEST_ID_BUILDERS.budgetDismiss('trial_preview_pays')).toBe(
      'budget-dismiss-trial_preview_pays'
    );
  });

  it('builds a kpi value id from a base kpi id', () => {
    expect(TEST_ID_BUILDERS.kpiValue('kpi-messages')).toBe('kpi-messages-value');
  });

  it('builds a fork tab id from a fork id', () => {
    expect(TEST_ID_BUILDERS.forkTab('f1')).toBe('fork-tab-f1');
  });

  it('builds a date range id from a range value', () => {
    expect(TEST_ID_BUILDERS.range('30d')).toBe('range-30d');
  });

  it('builds a persona card id from a persona name', () => {
    expect(TEST_ID_BUILDERS.personaCard('alice')).toBe('persona-card-alice');
  });

  it('builds a suggestion slot id from an index', () => {
    expect(TEST_ID_BUILDERS.suggestionSlot(0)).toBe('suggestion-slot-0');
  });

  it('builds a queued message item id from an index', () => {
    expect(TEST_ID_BUILDERS.queuedMessageItem(0)).toBe('queued-message-item-0');
  });

  it('builds a queued message cancel id from an index', () => {
    expect(TEST_ID_BUILDERS.queuedMessageCancel(2)).toBe('queued-message-cancel-2');
  });

  it('builds a word check id from an index', () => {
    expect(TEST_ID_BUILDERS.wordCheck(3)).toBe('word-check-3');
  });

  it('builds an add member result id from a user id', () => {
    expect(TEST_ID_BUILDERS.addMemberResult('u1')).toBe('add-member-result-u1');
  });

  it('builds a dev simulate id from a code', () => {
    expect(TEST_ID_BUILDERS.devSimulate('rate_limited')).toBe('dev-simulate-rate_limited');
  });

  it('builds a splash id from a variant', () => {
    expect(TEST_ID_BUILDERS.splash('dark')).toBe('splash-dark');
  });

  it('builds a social banner id from a variant', () => {
    expect(TEST_ID_BUILDERS.socialBanner('dark')).toBe('social-banner-dark');
    expect(TEST_ID_BUILDERS.socialBanner('light')).toBe('social-banner-light');
  });

  it('builds asset ids from an asset name', () => {
    expect(TEST_ID_BUILDERS.assetCard('banner')).toBe('asset-card-banner');
    expect(TEST_ID_BUILDERS.assetPreview('banner')).toBe('asset-preview-banner');
    expect(TEST_ID_BUILDERS.assetLink('banner')).toBe('asset-link-banner');
    expect(TEST_ID_BUILDERS.assetOpenImage('banner')).toBe('asset-open-image-banner');
  });

  it('builds a resolution group id from a resolution name', () => {
    expect(TEST_ID_BUILDERS.resolutionGroup('mobile')).toBe('resolution-group-mobile');
  });

  it('builds screenshot ids from a resolution name and screenshot name', () => {
    expect(TEST_ID_BUILDERS.screenshotCard('mobile', 'home')).toBe('screenshot-card-mobile-home');
    expect(TEST_ID_BUILDERS.screenshotOpenImage('mobile', 'home')).toBe(
      'screenshot-open-image-mobile-home'
    );
  });

  it('builds a feedback row id from a feedback id', () => {
    expect(TEST_ID_BUILDERS.feedbackRow('f1')).toBe('feedback-row-f1');
  });

  it('builds an admin op boolean toggle id from a field name', () => {
    expect(TEST_ID_BUILDERS.adminOpBooleanToggle('enabled')).toBe('admin-op-boolean-enabled');
  });

  it('builds an admin op group container id from a field name', () => {
    expect(TEST_ID_BUILDERS.adminOpGroup('messages')).toBe('admin-op-group-messages');
  });

  it('builds admin op group row ids from a field name and row index', () => {
    expect(TEST_ID_BUILDERS.adminOpGroupRow('messages', 0)).toBe('admin-op-group-row-messages-0');
    expect(TEST_ID_BUILDERS.adminOpGroupRowDelete('messages', 1)).toBe(
      'admin-op-group-row-delete-messages-1'
    );
  });

  it('builds admin op group row move ids from a field name and row index', () => {
    expect(TEST_ID_BUILDERS.adminOpGroupRowMoveUp('messages', 1)).toBe(
      'admin-op-group-row-move-up-messages-1'
    );
    expect(TEST_ID_BUILDERS.adminOpGroupRowMoveDown('messages', 0)).toBe(
      'admin-op-group-row-move-down-messages-0'
    );
  });

  it('builds an admin op group prepend id from a field name', () => {
    expect(TEST_ID_BUILDERS.adminOpGroupPrepend('messages')).toBe(
      'admin-op-group-prepend-messages'
    );
  });

  it('builds a growth panel frame id from what the panel\u2019s reads have done', () => {
    expect(TEST_ID_BUILDERS.adminGrowthPanel('pending')).toBe('admin-growth-panel-pending');
    expect(TEST_ID_BUILDERS.adminGrowthPanel('failed')).toBe('admin-growth-panel-failed');
    expect(TEST_ID_BUILDERS.adminGrowthPanel('answered')).toBe('admin-growth-panel-answered');
  });

  it('builds a conversation group id from a group label', () => {
    expect(TEST_ID_BUILDERS.conversationGroup('Today')).toBe('conversation-group-Today');
  });

  it('builds a conversation row id from a conversation id', () => {
    expect(TEST_ID_BUILDERS.conversationRow('c1')).toBe('conversation-row-c1');
  });

  it('builds a continue entry id from an index', () => {
    expect(TEST_ID_BUILDERS.continueEntry(1)).toBe('continue-entry-1');
  });

  it('builds a mode menu item id from a modality', () => {
    expect(TEST_ID_BUILDERS.modeMenuItem('image')).toBe('mode-menu-item-image');
  });

  it('builds a branch row id from a fork id', () => {
    expect(TEST_ID_BUILDERS.branchRow('f1')).toBe('branch-row-f1');
  });

  it('builds a branch rename id from a fork id', () => {
    expect(TEST_ID_BUILDERS.branchRename('f1')).toBe('branch-rename-f1');
  });

  it('builds a branch delete id from a fork id', () => {
    expect(TEST_ID_BUILDERS.branchDelete('f1')).toBe('branch-delete-f1');
  });

  it('builds a compare tab id from an index', () => {
    expect(TEST_ID_BUILDERS.compareTab(0)).toBe('compare-tab-0');
  });

  it('builds a compare column id from an index', () => {
    expect(TEST_ID_BUILDERS.compareColumn(2)).toBe('compare-column-2');
  });

  it('builds a scheme-qualified email frame id from a template name and scheme', () => {
    expect(TEST_ID_BUILDERS.emailSchemeIframe('verify', 'dark')).toBe(
      'email-scheme-iframe-verify-dark'
    );
    expect(TEST_ID_BUILDERS.emailSchemeIframe('verify', 'light')).toBe(
      'email-scheme-iframe-verify-light'
    );
  });

  it('builds an add-member privilege toggle id from a privilege', () => {
    expect(TEST_ID_BUILDERS.addMemberPrivilege('write')).toBe('add-member-privilege-write');
  });

  it('builds an invite-link privilege toggle id from a privilege', () => {
    expect(TEST_ID_BUILDERS.inviteLinkPrivilege('read')).toBe('invite-link-privilege-read');
  });

  it('builds privilege toggle ids that no static id shares', () => {
    const staticIds: readonly string[] = Object.values(TEST_IDS);
    for (const privilege of MEMBER_PRIVILEGES) {
      expect(staticIds).not.toContain(TEST_ID_BUILDERS.addMemberPrivilege(privilege));
      expect(staticIds).not.toContain(TEST_ID_BUILDERS.inviteLinkPrivilege(privilege));
    }
  });

  it('builds a member money id from a member or link id', () => {
    expect(TEST_ID_BUILDERS.memberMoney('m1')).toBe('member-money-m1');
  });
});

describe('the composer-notice builders', () => {
  it('resolve the trial count like any stack element', () => {
    expect(TEST_ID_BUILDERS.budgetMessage(TRIAL_REMAINING_MESSAGE_ID)).toBe(
      'budget-message-trial_messages_remaining'
    );
  });

  // A spec naming a retired or misspelled reason must fail to compile: an
  // absence assertion over an id nothing renders passes whatever the page shows.
  it('address a notice only by a composer notice id', () => {
    expectTypeOf(TEST_ID_BUILDERS.budgetMessage).parameter(0).toEqualTypeOf<ComposerNoticeId>();
  });

  it('address a notice icon only by a composer notice id', () => {
    expectTypeOf(TEST_ID_BUILDERS.budgetMessageIcon).parameter(0).toEqualTypeOf<ComposerNoticeId>();
  });

  it('address a notice dismiss control only by a composer notice id', () => {
    expectTypeOf(TEST_ID_BUILDERS.budgetDismiss).parameter(0).toEqualTypeOf<ComposerNoticeId>();
  });
});
