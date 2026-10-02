import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AnswerBotPanel } from './answer-bot-panel';
import type { ContentInfo } from '../engine';

function content(overrides: Partial<ContentInfo>): ContentInfo {
  return {
    h1Count: 1,
    headingOutline: [{ level: 1, text: 'Heading' }],
    hasSkippedHeadingLevels: false,
    wordCount: 200,
    textToHtmlRatio: 0.5,
    links: { internal: 3, external: 1, nofollow: 0 },
    images: { total: 2, withAlt: 2 },
    textBlob: 'Plenty of readable prose for a crawler to ingest.',
    ...overrides,
  };
}

describe('AnswerBotPanel', () => {
  it('makes the empty-body failure loud when word count is near zero', () => {
    render(<AnswerBotPanel content={content({ wordCount: 0, textBlob: '' })} />);

    expect(screen.getByText(/Near-empty page for no-JavaScript crawlers/i)).toBeInTheDocument();
    expect(screen.getByText('0 words')).toBeInTheDocument();
  });

  it('does not show the empty-body highlight for a healthy page', () => {
    render(<AnswerBotPanel content={content({ wordCount: 200 })} />);

    expect(
      screen.queryByText(/Near-empty page for no-JavaScript crawlers/i)
    ).not.toBeInTheDocument();
    expect(screen.getByText('200 words')).toBeInTheDocument();
  });

  it('reports an empty heading outline explicitly', () => {
    render(<AnswerBotPanel content={content({ headingOutline: [] })} />);

    expect(screen.getByText('No headings found.')).toBeInTheDocument();
  });

  it('lists each captured heading with its level', () => {
    render(
      <AnswerBotPanel
        content={content({
          headingOutline: [
            { level: 1, text: 'Pricing' },
            { level: 2, text: 'Plans' },
          ],
        })}
      />
    );

    const outline = screen.getByRole('list');
    expect(outline).toHaveTextContent('H1Pricing');
    expect(outline).toHaveTextContent('H2Plans');
  });

  it('says so when no text could be extracted at all', () => {
    render(<AnswerBotPanel content={content({ wordCount: 0, textBlob: '   ' })} />);

    expect(screen.getByText('(no text extracted)')).toBeInTheDocument();
  });

  it('shows the extracted text verbatim when the page has prose', () => {
    render(<AnswerBotPanel content={content({ textBlob: 'Verbatim crawlable prose.' })} />);

    expect(screen.getByText('Verbatim crawlable prose.')).toBeInTheDocument();
  });
});
