import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, beforeEach } from 'vitest';
import { DocumentCard } from './document-card';
import { useDocumentStore } from '../../stores/document';
import type { Document } from '../../lib/document-parser';

describe('DocumentCard', () => {
  const createDocument = (overrides: Partial<Document> = {}): Document => ({
    id: 'doc-123',
    type: 'code',
    language: 'typescript',
    title: 'MyComponent',
    content: 'const x = 1;',
    lineCount: 20,
    ...overrides,
  });

  const createDocumentWithoutLanguage = (type: Document['type']): Document => ({
    id: 'doc-123',
    type,
    title: 'MyComponent',
    content: 'const x = 1;',
    lineCount: 20,
  });

  beforeEach(() => {
    useDocumentStore.setState({
      isPanelOpen: false,
      panelWidth: 400,
      activeDocumentId: null,
    });
  });

  describe('rendering', () => {
    it('renders document title', () => {
      render(<DocumentCard document={createDocument({ title: 'UserService' })} />);

      expect(screen.getByText('UserService')).toBeInTheDocument();
    });

    it('renders language and line count for code documents', () => {
      render(<DocumentCard document={createDocument({ language: 'python', lineCount: 42 })} />);

      expect(screen.getByText(/python/i)).toBeInTheDocument();
      expect(screen.getByText(/42 lines/i)).toBeInTheDocument();
    });

    it('renders type label for mermaid documents', () => {
      render(
        <DocumentCard
          document={createDocument({
            type: 'mermaid',
            language: 'mermaid',
            title: 'Flowchart Diagram',
          })}
        />
      );

      expect(screen.getByText(/mermaid/i)).toBeInTheDocument();
    });

    it('renders type label for html documents', () => {
      render(<DocumentCard document={createDocument({ type: 'html', language: 'html' })} />);

      expect(screen.getByText(/html/i)).toBeInTheDocument();
    });

    it('renders type label for react documents', () => {
      render(<DocumentCard document={createDocument({ type: 'react', language: 'tsx' })} />);

      expect(screen.getByText(/tsx/i)).toBeInTheDocument();
    });

    it('renders Mermaid label when language is undefined for mermaid type', () => {
      render(<DocumentCard document={createDocumentWithoutLanguage('mermaid')} />);

      expect(screen.getByText(/mermaid/i)).toBeInTheDocument();
    });

    it('renders HTML label when language is undefined for html type', () => {
      render(<DocumentCard document={createDocumentWithoutLanguage('html')} />);

      expect(screen.getByText(/html/i)).toBeInTheDocument();
    });

    it('renders React label when language is undefined for react type', () => {
      render(<DocumentCard document={createDocumentWithoutLanguage('react')} />);

      expect(screen.getByText(/react/i)).toBeInTheDocument();
    });

    it('renders Code label when language is undefined for code type', () => {
      render(<DocumentCard document={createDocumentWithoutLanguage('code')} />);

      expect(screen.getByText(/code/i)).toBeInTheDocument();
    });
  });

  describe('icons', () => {
    it('renders code icon for code documents', () => {
      render(<DocumentCard document={createDocument({ type: 'code' })} />);

      const card = screen.getByTestId('document-card');
      expect(card.querySelector('[data-testid="code-icon"]')).toBeInTheDocument();
    });

    it('renders diagram icon for mermaid documents', () => {
      render(<DocumentCard document={createDocument({ type: 'mermaid' })} />);

      const card = screen.getByTestId('document-card');
      expect(card.querySelector('[data-testid="diagram-icon"]')).toBeInTheDocument();
    });

    it('renders html icon for html documents', () => {
      render(<DocumentCard document={createDocument({ type: 'html' })} />);

      const card = screen.getByTestId('document-card');
      expect(card.querySelector('[data-testid="html-icon"]')).toBeInTheDocument();
    });

    it('renders react icon for react documents', () => {
      render(<DocumentCard document={createDocument({ type: 'react' })} />);

      const card = screen.getByTestId('document-card');
      expect(card.querySelector('[data-testid="react-icon"]')).toBeInTheDocument();
    });

    it('renders open arrow icon', () => {
      render(<DocumentCard document={createDocument()} />);

      const card = screen.getByTestId('document-card');
      expect(card.querySelector('[data-testid="open-icon"]')).toBeInTheDocument();
    });
  });

  describe('interaction', () => {
    it('sets active document when clicked', async () => {
      const user = userEvent.setup();
      render(<DocumentCard document={createDocument({ id: 'doc-clicked' })} />);

      await user.click(screen.getByTestId('document-card'));

      expect(useDocumentStore.getState().activeDocumentId).toBe('doc-clicked');
    });

    it('opens panel when clicked', async () => {
      const user = userEvent.setup();
      render(<DocumentCard document={createDocument()} />);

      await user.click(screen.getByTestId('document-card'));

      expect(useDocumentStore.getState().isPanelOpen).toBe(true);
    });
  });

  describe('active state', () => {
    it('shows active indicator when document is active', () => {
      useDocumentStore.setState({ activeDocumentId: 'doc-active', isPanelOpen: true });
      render(<DocumentCard document={createDocument({ id: 'doc-active' })} />);

      const card = screen.getByTestId('document-card');
      expect(card).toHaveAttribute('data-active', 'true');
    });

    it('does not show active indicator when document is not active', () => {
      useDocumentStore.setState({ activeDocumentId: 'doc-other', isPanelOpen: true });
      render(<DocumentCard document={createDocument({ id: 'doc-123' })} />);

      const card = screen.getByTestId('document-card');
      expect(card).toHaveAttribute('data-active', 'false');
    });
  });

  describe('accessibility', () => {
    it('has button role for clickability', () => {
      render(<DocumentCard document={createDocument()} />);

      expect(screen.getByRole('button')).toBeInTheDocument();
    });

    it('has accessible name from title', () => {
      render(<DocumentCard document={createDocument({ title: 'DataProcessor' })} />);

      expect(screen.getByRole('button', { name: /dataprocessor/i })).toBeInTheDocument();
    });
  });
});
