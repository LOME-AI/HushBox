import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './tabs';

describe('Tabs', () => {
  it('renders tabs with triggers and content', () => {
    render(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1">Tab 1</TabsTrigger>
          <TabsTrigger value="tab2">Tab 2</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">Content 1</TabsContent>
        <TabsContent value="tab2">Content 2</TabsContent>
      </Tabs>
    );
    expect(screen.getByText('Tab 1')).toBeInTheDocument();
    expect(screen.getByText('Tab 2')).toBeInTheDocument();
    expect(screen.getByText('Content 1')).toBeInTheDocument();
  });

  it('switches content when tab is clicked', async () => {
    const user = userEvent.setup();
    render(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1">Tab 1</TabsTrigger>
          <TabsTrigger value="tab2">Tab 2</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">Content 1</TabsContent>
        <TabsContent value="tab2">Content 2</TabsContent>
      </Tabs>
    );

    expect(screen.getByRole('tabpanel')).toHaveTextContent('Content 1');

    await user.click(screen.getByText('Tab 2'));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Content 2');
  });

  it('has data-slot attribute on root', () => {
    render(
      <Tabs defaultValue="tab1" data-testid="tabs">
        <TabsList>
          <TabsTrigger value="tab1">Tab</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">Content</TabsContent>
      </Tabs>
    );
    expect(screen.getByTestId('tabs')).toHaveAttribute('data-slot', 'tabs');
  });

  it('applies custom className', () => {
    render(
      <Tabs defaultValue="tab1" className="custom-class" data-testid="tabs">
        <TabsList>
          <TabsTrigger value="tab1">Tab</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">Content</TabsContent>
      </Tabs>
    );
    expect(screen.getByTestId('tabs')).toHaveClass('custom-class');
  });

  it('renders controlled tabs', async () => {
    const onValueChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Tabs value="tab1" onValueChange={onValueChange}>
        <TabsList>
          <TabsTrigger value="tab1">Tab 1</TabsTrigger>
          <TabsTrigger value="tab2">Tab 2</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">Content 1</TabsContent>
        <TabsContent value="tab2">Content 2</TabsContent>
      </Tabs>
    );

    await user.click(screen.getByText('Tab 2'));
    expect(onValueChange).toHaveBeenCalledWith('tab2');
  });

  it('moves focus to the next trigger with the arrow keys', async () => {
    const user = userEvent.setup();
    render(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1">Tab 1</TabsTrigger>
          <TabsTrigger value="tab2">Tab 2</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">Content 1</TabsContent>
        <TabsContent value="tab2">Content 2</TabsContent>
      </Tabs>
    );

    await user.tab();
    expect(screen.getByRole('tab', { name: 'Tab 1' })).toHaveFocus();

    await user.keyboard('{ArrowRight}');

    const second = screen.getByRole('tab', { name: 'Tab 2' });
    expect(second).toHaveFocus();
    expect(second).toHaveAttribute('data-slot', 'tabs-trigger');
  });

  it('returns focus to the trigger the arrow keys moved to when the tab order comes back', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Before</button>
        <Tabs defaultValue="tab1">
          <TabsList>
            <TabsTrigger value="tab1">Tab 1</TabsTrigger>
            <TabsTrigger value="tab2">Tab 2</TabsTrigger>
          </TabsList>
          <TabsContent value="tab1">Content 1</TabsContent>
          <TabsContent value="tab2">Content 2</TabsContent>
        </Tabs>
      </>
    );

    await user.tab();
    await user.tab();
    await user.keyboard('{ArrowRight}');

    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Before' })).toHaveFocus();

    await user.tab();

    expect(screen.getByRole('tab', { name: 'Tab 2' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Tab 1' })).toHaveAttribute('tabindex', '-1');
  });
});

describe('TabsList', () => {
  it('has data-slot attribute', () => {
    render(
      <Tabs defaultValue="tab1">
        <TabsList data-testid="list">
          <TabsTrigger value="tab1">Tab</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">Content</TabsContent>
      </Tabs>
    );
    expect(screen.getByTestId('list')).toHaveAttribute('data-slot', 'tabs-list');
  });

  it('applies custom className', () => {
    render(
      <Tabs defaultValue="tab1">
        <TabsList className="custom-class" data-testid="list">
          <TabsTrigger value="tab1">Tab</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">Content</TabsContent>
      </Tabs>
    );
    expect(screen.getByTestId('list')).toHaveClass('custom-class');
  });

  it('renders as tablist role', () => {
    render(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1">Tab</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">Content</TabsContent>
      </Tabs>
    );
    expect(screen.getByRole('tablist')).toBeInTheDocument();
  });
});

describe('TabsTrigger', () => {
  it('has data-slot attribute', () => {
    render(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1" data-testid="trigger">
            Tab
          </TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">Content</TabsContent>
      </Tabs>
    );
    expect(screen.getByTestId('trigger')).toHaveAttribute('data-slot', 'tabs-trigger');
  });

  it('applies custom className', () => {
    render(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1" className="custom-class" data-testid="trigger">
            Tab
          </TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">Content</TabsContent>
      </Tabs>
    );
    expect(screen.getByTestId('trigger')).toHaveClass('custom-class');
  });

  it('has active state when selected', () => {
    render(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1" data-testid="trigger">
            Tab
          </TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">Content</TabsContent>
      </Tabs>
    );
    expect(screen.getByTestId('trigger')).toHaveAttribute('data-state', 'active');
  });

  it('has inactive state when not selected', () => {
    render(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1">Tab 1</TabsTrigger>
          <TabsTrigger value="tab2" data-testid="trigger">
            Tab 2
          </TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">Content 1</TabsContent>
        <TabsContent value="tab2">Content 2</TabsContent>
      </Tabs>
    );
    expect(screen.getByTestId('trigger')).toHaveAttribute('data-state', 'inactive');
  });

  it('renders as tab role', () => {
    render(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1">Tab</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">Content</TabsContent>
      </Tabs>
    );
    expect(screen.getByRole('tab')).toBeInTheDocument();
  });

  it('supports disabled state', () => {
    render(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1" disabled data-testid="trigger">
            Tab
          </TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">Content</TabsContent>
      </Tabs>
    );
    expect(screen.getByTestId('trigger')).toBeDisabled();
  });
});

describe('TabsContent', () => {
  it('has data-slot attribute', () => {
    render(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1">Tab</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1" data-testid="content">
          Content
        </TabsContent>
      </Tabs>
    );
    expect(screen.getByTestId('content')).toHaveAttribute('data-slot', 'tabs-content');
  });

  it('applies custom className', () => {
    render(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1">Tab</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1" className="custom-class" data-testid="content">
          Content
        </TabsContent>
      </Tabs>
    );
    expect(screen.getByTestId('content')).toHaveClass('custom-class');
  });

  it('renders as tabpanel role', () => {
    render(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1">Tab</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">Content</TabsContent>
      </Tabs>
    );
    expect(screen.getByRole('tabpanel')).toBeInTheDocument();
  });

  // Radix puts the panel in the tab order (`tabIndex: 0`), so it needs its own
  // indicator; `outline-none` alone leaves a keyboard-reachable element with none.
  it('gives the keyboard-reachable panel the package focus ring', () => {
    render(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1">Tab</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">Content</TabsContent>
      </Tabs>
    );

    const panel = screen.getByRole('tabpanel');
    expect(panel.tabIndex).toBe(0);

    const classes = panel.className.split(/\s+/);
    expect(classes).toContain('focus-visible:ring-ring/50');
    expect(classes).toContain('focus-visible:ring-[3px]');
  });

  // The halo is `ring-ring/50`: measured on rendered pixels it reaches 1.92:1
  // against the surface behind it, under SC 1.4.11's 3:1. The trigger already
  // pairs it with a full-opacity outline that carries the contrast; the panel
  // is the part of the pattern that shipped without one.
  it('carries the panel focus indicator on a full-opacity outline', () => {
    render(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1">Tab</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">Content</TabsContent>
      </Tabs>
    );

    const classes = screen.getByRole('tabpanel').className.split(/\s+/);
    expect(classes).toContain('focus-visible:outline-ring');
    expect(classes).toContain('focus-visible:outline-1');
    expect(classes).not.toContain('outline-none');
  });
});
