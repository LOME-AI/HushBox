import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { defaultParseSearch } from '@tanstack/react-router';
import { ADMIN_AUDIT_PATH, TEST_IDS, adminAuditDayFilter, adminAuditLink } from '@hushbox/shared';
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  TEST_DAY_START,
  isoAt,
  testUuidV7,
} from '@hushbox/shared/test-time';
import { OpModalProvider } from '@/components/ops/op-modal-provider';
import { router } from '../router.js';
import { Route } from './audit.js';
import type { AdminAuditLinkFilter } from '@hushbox/shared';
import type { AuditFilters } from '@/hooks/use-audit-search';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type ValidateSearch = (search: Record<string, unknown>) => AuditFilters;

function validateSearch(search: Record<string, unknown>): AuditFilters {
  return (
    Route as unknown as { options: { validateSearch: ValidateSearch } }
  ).options.validateSearch(search);
}

function renderScreen(search: AuditFilters): { navigate: ReturnType<typeof vi.fn> } {
  const navigate = vi.fn();
  vi.spyOn(Route, 'useSearch').mockReturnValue(search);
  vi.spyOn(Route, 'useNavigate').mockReturnValue(navigate);
  const Component = (Route as { options?: { component?: React.ComponentType } }).options?.component;
  if (Component === undefined) {
    throw new Error('audit route has no component');
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OpModalProvider>
        <Component />
      </OpModalProvider>
    </QueryClientProvider>
  );
  return { navigate };
}

const FILTER_FROM = isoAt(TEST_DAY_START);
const FILTER_TO = isoAt(TEST_DAY_START + 10 * HOUR_MS + 30 * MINUTE_MS);
/** What a URL actually carries: a zone suffix, no subsecond field. */
const withoutSubseconds = (instant: string): string => instant.replace('.000Z', 'Z');
const AUDIT_LINK_ORIGIN = 'https://admin.hushbox.ai';
const AUDIT_LINK_TARGET_ID = testUuidV7(1);

describe('Audit route', () => {
  it('keeps only known, non-empty string filters from the URL', () => {
    expect(validateSearch({ actor: 'a', action: '', from: 42, bogus: 'x', targetId: 't' })).toEqual(
      { actor: 'a', targetId: 't' }
    );
    expect(validateSearch({})).toEqual({});
  });

  it('normalizes URL-supplied datetime filters to full ISO', () => {
    expect(
      validateSearch({ from: FILTER_FROM.slice(0, 10), to: withoutSubseconds(FILTER_TO) })
    ).toEqual({ from: FILTER_FROM, to: FILTER_TO });
  });

  it('drops an unparseable URL datetime instead of sending a guaranteed 400', () => {
    expect(
      validateSearch({ from: 'garbage', to: withoutSubseconds(FILTER_FROM), actor: 'a' })
    ).toEqual({ to: FILTER_FROM, actor: 'a' });
  });

  it('is the route the router resolves the audit link path to', () => {
    expect(router.routesByPath[ADMIN_AUDIT_PATH]).toBe(Route);
  });

  it.each<[string, AdminAuditLinkFilter]>([
    ['a target', { targetId: AUDIT_LINK_TARGET_ID }],
    ['a time window', { from: FILTER_FROM, to: FILTER_TO }],
    [
      'an action over a time window',
      { action: 'jobs.redriveAll', from: FILTER_FROM, to: FILTER_TO },
    ],
  ])('reads back every filter of an audit link to %s', (_shape, filter) => {
    const search = new URL(adminAuditLink(AUDIT_LINK_ORIGIN, filter)).search;
    expect(validateSearch(defaultParseSearch(search))).toEqual(filter);
  });

  it('reads a day link back as that day’s midnight to the next midnight', () => {
    const day = isoAt(TEST_DAY_START).slice(0, 10);
    const search = new URL(adminAuditLink(AUDIT_LINK_ORIGIN, adminAuditDayFilter(day))).search;
    expect(validateSearch(defaultParseSearch(search))).toEqual({
      from: isoAt(TEST_DAY_START),
      to: isoAt(TEST_DAY_START + DAY_MS),
    });
  });

  it('renders the trail screen with URL filters applied as pills', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ rows: [], nextCursor: null })))
    );
    renderScreen({ action: 'user.lock' });
    expect(screen.getByRole('heading', { name: 'Audit trail' })).toBeInTheDocument();
    expect(await screen.findByTestId(TEST_IDS.adminAuditFilterPill)).toHaveTextContent('user.lock');
  });

  it('round-trips filter changes through router navigation (URL ownership)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ rows: [], nextCursor: null })))
    );
    const { navigate } = renderScreen({});
    await userEvent.type(screen.getByLabelText('Action'), 'job.discard');
    await userEvent.click(screen.getByTestId(TEST_IDS.adminAuditApplyFilters));
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith({ search: { action: 'job.discard' } });
    });
  });
});
