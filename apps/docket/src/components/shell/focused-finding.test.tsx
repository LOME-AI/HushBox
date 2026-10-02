import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { makeFinding } from '@/test-utils/finding-fixture';
import { FocusedFinding } from './focused-finding';

const LONG_TITLE = `${'a very long sentence that keeps going '.repeat(20)}end`;

describe('FocusedFinding', () => {
  it('leads with the finding id', () => {
    render(<FocusedFinding finding={makeFinding({ id: 'DB-3' })} />);

    expect(screen.getByText('DB-3')).toBeInTheDocument();
  });

  it('renders a title the audit wrote in markdown, rather than showing its source', () => {
    const { container } = render(
      <FocusedFinding
        finding={makeFinding({
          id: 'DB-3',
          title: 'A bare fetch slips past the rule',
          titleHtml: 'A bare <code>fetch</code> slips past the rule',
        })}
      />
    );

    expect(container.querySelector('code')).toHaveTextContent('fetch');
  });

  it('shows the whole title, however long, without clamping it', () => {
    render(<FocusedFinding finding={makeFinding({ id: 'DB-3', title: LONG_TITLE })} />);

    const title = screen.getByRole('heading', { level: 2 });

    expect(title).toHaveTextContent('end');
    expect(title.className).toContain('break-words');
    expect(title.className).not.toContain('line-clamp');
  });

  it('shows severity, status, kind and area', () => {
    render(
      <FocusedFinding
        finding={makeFinding({
          id: 'DB-3',
          severity: 'high',
          status: 'latent',
          kind: 'decision',
          area: 'unknown',
        })}
      />
    );

    expect(screen.getByText('high')).toBeInTheDocument();
    expect(screen.getByText('latent')).toBeInTheDocument();
    expect(screen.getByText('decision')).toBeInTheDocument();
    expect(screen.getByText('unknown')).toBeInTheDocument();
  });

  it('flags a warned finding', () => {
    render(<FocusedFinding finding={makeFinding({ id: 'DB-3', warning: true })} />);

    expect(screen.getByText('warning')).toBeInTheDocument();
  });

  it('says nothing about warnings on a finding that carries none', () => {
    render(<FocusedFinding finding={makeFinding({ id: 'DB-3' })} />);

    expect(screen.queryByText('warning')).not.toBeInTheDocument();
  });

  it('shows the status note when the audit qualified the status', () => {
    render(
      <FocusedFinding
        finding={makeFinding({ id: 'DB-3', statusNote: 'live only under the bulk shard' })}
      />
    );

    expect(screen.getByText('live only under the bulk shard')).toBeInTheDocument();
  });

  it('reads the status and its note as the one sentence the audit wrote', () => {
    const { container } = render(
      <FocusedFinding
        finding={makeFinding({
          id: 'UI-11',
          status: 'live',
          statusNote: '(announced glyph) / latent (the height cap)',
        })}
      />
    );

    expect(container.querySelector('[data-slot="status"]')).toHaveTextContent(
      'live (announced glyph) / latent (the height cap)'
    );
  });

  it('separates a note from the status with a space collapsing cannot take away', () => {
    const { container } = render(
      <FocusedFinding
        finding={makeFinding({
          id: 'UI-11',
          status: 'live',
          statusNote: '(announced glyph) / latent (the height cap)',
        })}
      />
    );

    expect(container.querySelector('[data-slot="status-note"]')?.textContent).toBe(
      '\u{A0}(announced glyph) / latent (the height cap)'
    );
  });

  it('runs a note the audit began with punctuation straight on from the status', () => {
    const { container } = render(
      <FocusedFinding
        finding={makeFinding({
          id: 'EN-22',
          status: 'latent',
          statusNote: '. No live evasion exists.',
        })}
      />
    );

    expect(container.querySelector('[data-slot="status"]')?.textContent).toBe(
      'latent. No live evasion exists.'
    );
  });

  it('keeps the note out from behind the title it used to sit under', () => {
    const { container } = render(
      <FocusedFinding
        finding={makeFinding({ id: 'DB-3', title: LONG_TITLE, statusNote: ', under load only' })}
      />
    );

    const note = container.querySelector('[data-slot="status-note"]');
    const title = screen.getByRole('heading', { level: 2 });

    expect(note?.compareDocumentPosition(title)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('says nothing where there is no status note', () => {
    const { container } = render(<FocusedFinding finding={makeFinding({ id: 'DB-3' })} />);

    expect(container.querySelector('[data-slot="status-note"]')).toBeNull();
  });
});
