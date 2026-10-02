import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SettingsGroup } from '@/components/settings/settings-group';

function listOf(groupName: string): HTMLElement {
  const list = screen
    .getByRole('region', { name: groupName })
    .querySelector('[data-settings-list]');
  if (!(list instanceof HTMLElement)) throw new TypeError('the group draws no list');
  return list;
}

describe('SettingsGroup', () => {
  it('titles the group with a level-2 heading', () => {
    render(
      <SettingsGroup id="security" title="Security">
        <div>row</div>
      </SettingsGroup>
    );

    expect(screen.getByRole('heading', { level: 2, name: 'Security' })).toBeInTheDocument();
  });

  it('is a region named by its title', () => {
    render(
      <SettingsGroup id="security" title="Security">
        <div>row</div>
      </SettingsGroup>
    );

    expect(screen.getByRole('region', { name: 'Security' })).toHaveAttribute('id', 'security');
  });

  it('sets the title in the sans title role', () => {
    render(
      <SettingsGroup id="security" title="Security">
        <div>row</div>
      </SettingsGroup>
    );

    expect(screen.getByRole('heading', { name: 'Security' })).toHaveClass(
      'text-title-3',
      'font-sans'
    );
  });

  it('keeps the heading its signal red by default', () => {
    render(
      <SettingsGroup id="security" title="Security">
        <div>row</div>
      </SettingsGroup>
    );

    expect(screen.getByRole('heading', { name: 'Security' })).not.toHaveClass('text-foreground');
    expect(
      screen.getByRole('heading', { name: 'Security' }).parentElement?.className
    ).not.toContain('text-destructive');
  });

  it('shows a muted description under the title when given', () => {
    render(
      <SettingsGroup id="notifications" title="Notifications" description="Push notifications.">
        <div>row</div>
      </SettingsGroup>
    );

    expect(screen.getByText('Push notifications.')).toHaveClass('text-muted-foreground');
  });

  it('draws no description when none is given', () => {
    const { container } = render(
      <SettingsGroup id="security" title="Security">
        <div>row</div>
      </SettingsGroup>
    );

    expect(screen.getByRole('heading', { name: 'Security' }).parentElement).toBe(
      container.querySelector('section')?.firstElementChild
    );
    expect(container.querySelectorAll('p')).toHaveLength(0);
  });

  it('renders its rows inside the list', () => {
    render(
      <SettingsGroup id="security" title="Security">
        <div>first row</div>
      </SettingsGroup>
    );

    expect(listOf('Security')).toContainElement(screen.getByText('first row'));
  });

  it('separates its rows with hairlines between a top and bottom rule', () => {
    render(
      <SettingsGroup id="security" title="Security">
        <div>row</div>
      </SettingsGroup>
    );

    expect(listOf('Security')).toHaveClass('border-y', 'border-border', '[&>*+*]:border-t');
  });

  it('makes the list a size container, so an inline action sizes to the list', () => {
    render(
      <SettingsGroup id="security" title="Security">
        <div>row</div>
      </SettingsGroup>
    );

    expect(listOf('Security')).toHaveClass('@container');
  });

  it('sets the danger title in the destructive red', () => {
    render(
      <SettingsGroup id="danger" title="Danger zone" tone="danger">
        <div>row</div>
      </SettingsGroup>
    );

    expect(screen.getByRole('heading', { name: 'Danger zone' }).parentElement).toHaveClass(
      '[&>h2]:text-destructive'
    );
  });

  it('draws the danger list rules in the error tint', () => {
    render(
      <SettingsGroup id="danger" title="Danger zone" tone="danger">
        <div>row</div>
      </SettingsGroup>
    );

    expect(listOf('Danger zone')).toHaveClass('border-y', 'border-error/55');
  });

  it('draws the attention list as the warning box', () => {
    render(
      <SettingsGroup id="attention" title="Needs attention" tone="attention">
        <div>row</div>
      </SettingsGroup>
    );

    expect(listOf('Needs attention')).toHaveClass(
      'rounded-lg',
      'border',
      'border-warning/45',
      'bg-warning/6',
      '[&>*+*]:border-warning/30'
    );
  });

  it('keeps the attention title its signal red', () => {
    render(
      <SettingsGroup id="attention" title="Needs attention" tone="attention">
        <div>row</div>
      </SettingsGroup>
    );

    expect(
      screen.getByRole('heading', { name: 'Needs attention' }).parentElement?.className
    ).not.toContain('text-destructive');
  });
});
