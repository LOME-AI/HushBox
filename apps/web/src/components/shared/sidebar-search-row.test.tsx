import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';
import { usePaletteStore } from '@/stores/ui/palette';
import { SidebarSearchRow } from './sidebar-search-row';

const SEARCH_NAME = 'Search conversations and actions';

describe('SidebarSearchRow', () => {
  describe('launcher', () => {
    beforeEach(() => {
      usePaletteStore.setState({ open: false });
    });

    it('renders a button named for what it searches', () => {
      render(<SidebarSearchRow mode="launcher" onOpen={vi.fn()} />);
      expect(screen.getByRole('button', { name: SEARCH_NAME })).toBeInTheDocument();
    });

    it('never submits a surrounding form', () => {
      render(<SidebarSearchRow mode="launcher" onOpen={vi.fn()} />);
      expect(screen.getByRole('button', { name: SEARCH_NAME })).toHaveAttribute('type', 'button');
    });

    it('shows "Search" as visible text', () => {
      render(<SidebarSearchRow mode="launcher" onOpen={vi.fn()} />);
      expect(screen.getByText('Search')).toBeInTheDocument();
    });

    it('carries the literal HTML id the native flows wait on', () => {
      render(<SidebarSearchRow mode="launcher" onOpen={vi.fn()} />);
      expect(screen.getByRole('button', { name: SEARCH_NAME })).toHaveAttribute(
        'id',
        'sidebar-search-row'
      );
    });

    it('carries the registry test id', () => {
      render(<SidebarSearchRow mode="launcher" onOpen={vi.fn()} />);
      expect(screen.getByTestId(TEST_IDS.sidebarSearchRow)).toBe(
        screen.getByRole('button', { name: SEARCH_NAME })
      );
    });

    it('opens the palette store when wired to it', async () => {
      const user = userEvent.setup();
      render(
        <SidebarSearchRow
          mode="launcher"
          onOpen={() => {
            usePaletteStore.getState().setOpen(true);
          }}
        />
      );

      await user.click(screen.getByRole('button', { name: SEARCH_NAME }));

      expect(usePaletteStore.getState().open).toBe(true);
    });

    it('draws the shortcut hint in the spaced text form', () => {
      render(<SidebarSearchRow mode="launcher" onOpen={vi.fn()} kbd="mod+k" />);
      expect(screen.getByText('Ctrl K').tagName).toBe('KBD');
    });

    it('draws no hint when none is given, as the trial sidebar asks', () => {
      const { container } = render(<SidebarSearchRow mode="launcher" onOpen={vi.fn()} />);
      expect(container.querySelector('kbd')).toBeNull();
    });

    it('keeps the hint out of the accessible name', () => {
      render(<SidebarSearchRow mode="launcher" onOpen={vi.fn()} kbd="mod+k" />);
      expect(screen.getByRole('button')).toHaveAccessibleName(SEARCH_NAME);
    });

    describe('collapsed to the rail', () => {
      it('keeps its accessible name', () => {
        render(<SidebarSearchRow mode="launcher" onOpen={vi.fn()} collapsed />);
        expect(screen.getByRole('button', { name: SEARCH_NAME })).toBeInTheDocument();
      });

      it('shows the icon alone', () => {
        render(<SidebarSearchRow mode="launcher" onOpen={vi.fn()} kbd="mod+k" collapsed />);
        expect(screen.queryByText('Search')).not.toBeInTheDocument();
      });

      it('draws no hint', () => {
        const { container } = render(
          <SidebarSearchRow mode="launcher" onOpen={vi.fn()} kbd="mod+k" collapsed />
        );
        expect(container.querySelector('kbd')).toBeNull();
      });
    });
  });

  describe('field', () => {
    it('renders a search field named by its label', () => {
      render(<SidebarSearchRow mode="field" label="Search members" value="" onChange={vi.fn()} />);
      expect(screen.getByRole('searchbox', { name: 'Search members' })).toBeInTheDocument();
    });

    it('shows its label as the placeholder', () => {
      render(<SidebarSearchRow mode="field" label="Search members" value="" onChange={vi.fn()} />);
      expect(screen.getByPlaceholderText('Search members')).toBeInTheDocument();
    });

    it('shows its value', () => {
      render(
        <SidebarSearchRow mode="field" label="Search members" value="ali" onChange={vi.fn()} />
      );
      expect(screen.getByRole('searchbox')).toHaveValue('ali');
    });

    it('reports each change as the new value', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<SidebarSearchRow mode="field" label="Search members" value="" onChange={onChange} />);

      await user.type(screen.getByRole('searchbox'), 'b');

      expect(onChange).toHaveBeenCalledWith('b');
    });

    it('is the inline input', () => {
      render(<SidebarSearchRow mode="field" label="Search members" value="" onChange={vi.fn()} />);
      expect(screen.getByRole('searchbox')).toHaveAttribute('data-slot', 'inline-input');
    });

    it('carries its test id on the field', () => {
      render(
        <SidebarSearchRow
          mode="field"
          label="Search members"
          value=""
          onChange={vi.fn()}
          testId="member-search"
        />
      );
      expect(screen.getByTestId('member-search')).toBe(screen.getByRole('searchbox'));
    });

    it('carries no launcher id', () => {
      const { container } = render(
        <SidebarSearchRow mode="field" label="Search members" value="" onChange={vi.fn()} />
      );
      expect(container.querySelector('#sidebar-search-row')).toBeNull();
    });
  });
});
