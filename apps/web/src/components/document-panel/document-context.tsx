import * as React from 'react';
import type { Document } from '../../lib/document-parser';

interface DocumentContextValue {
  documents: Document[];
  registerDocuments: (messageId: string, docs: Document[]) => void;
  unregisterDocuments: (messageId: string) => void;
}

const DocumentContext = React.createContext<DocumentContextValue | null>(null);

interface DocumentProviderProps {
  children: React.ReactNode;
}

export function DocumentProvider({ children }: DocumentProviderProps): React.JSX.Element {
  // Store documents keyed by message ID to allow cleanup
  const [documentsByMessage, setDocumentsByMessage] = React.useState<Record<string, Document[]>>(
    {}
  );

  const registerDocuments = React.useCallback((messageId: string, docs: Document[]): void => {
    setDocumentsByMessage((prev) => ({
      ...prev,
      [messageId]: docs,
    }));
  }, []);

  const unregisterDocuments = React.useCallback((messageId: string): void => {
    setDocumentsByMessage((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([key]) => key !== messageId))
    );
  }, []);

  // Flatten all documents from all messages
  const documents = React.useMemo(() => {
    return Object.values(documentsByMessage).flat();
  }, [documentsByMessage]);

  const value = React.useMemo(
    () => ({
      documents,
      registerDocuments,
      unregisterDocuments,
    }),
    [documents, registerDocuments, unregisterDocuments]
  );

  return <DocumentContext.Provider value={value}>{children}</DocumentContext.Provider>;
}

export function useDocuments(): DocumentContextValue {
  const context = React.useContext(DocumentContext);
  if (!context) {
    throw new Error('useDocuments must be used within a DocumentProvider');
  }
  return context;
}
