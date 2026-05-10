import { describe, it, expect } from 'vitest';
import { SentenceChunker } from './sentence-chunker';

describe('SentenceChunker.feed', () => {
  it('returns a single complete sentence in one feed() call', () => {
    const chunker = new SentenceChunker();
    expect(chunker.feed('Hello world. ')).toEqual(['Hello world.']);
  });

  it('returns nothing when only a partial sentence has been fed', () => {
    const chunker = new SentenceChunker();
    expect(chunker.feed('Hello wor')).toEqual([]);
  });

  it('returns the sentence after the final boundary character is fed', () => {
    const chunker = new SentenceChunker();
    expect(chunker.feed('Hello wor')).toEqual([]);
    expect(chunker.feed('ld. Next text')).toEqual(['Hello world.']);
  });

  it('returns multiple sentences in a single feed() call', () => {
    const chunker = new SentenceChunker();
    expect(chunker.feed('First sentence. Second sentence! Third? ')).toEqual([
      'First sentence.',
      'Second sentence!',
      'Third?',
    ]);
  });

  it('does not split on common abbreviations like Mr.', () => {
    const chunker = new SentenceChunker();
    expect(chunker.feed('Mr. Smith went home. ')).toEqual(['Mr. Smith went home.']);
  });

  it('does not split on common abbreviations like Mrs., Ms., Dr.', () => {
    const chunker = new SentenceChunker();
    expect(chunker.feed('Dr. Jones met Mrs. Lee and Ms. Park today. ')).toEqual([
      'Dr. Jones met Mrs. Lee and Ms. Park today.',
    ]);
  });

  it('does not split on Prof. abbreviation', () => {
    const chunker = new SentenceChunker();
    expect(chunker.feed('Prof. Brown teaches math. ')).toEqual(['Prof. Brown teaches math.']);
  });

  it('does not split on St. abbreviation', () => {
    const chunker = new SentenceChunker();
    expect(chunker.feed('St. Mary visited. ')).toEqual(['St. Mary visited.']);
  });

  it('does not split on vs., e.g., i.e., etc. abbreviations', () => {
    const chunker = new SentenceChunker();
    expect(chunker.feed('Apples vs. oranges, e.g. fruit, i.e. produce, etc. matter. ')).toEqual([
      'Apples vs. oranges, e.g. fruit, i.e. produce, etc. matter.',
    ]);
  });

  it('does not split on Sr., Jr., Inc., Ltd., Co., Corp.', () => {
    const chunker = new SentenceChunker();
    expect(
      chunker.feed(
        'John Sr. and John Jr. work at Acme Inc. and Beta Ltd. and Gamma Co. Corp. now. '
      )
    ).toEqual(['John Sr. and John Jr. work at Acme Inc. and Beta Ltd. and Gamma Co. Corp. now.']);
  });

  it('does not split on a numeric decimal like 1.5', () => {
    const chunker = new SentenceChunker();
    expect(chunker.feed('The value is 1.5 today. ')).toEqual(['The value is 1.5 today.']);
  });

  it('strips fenced code blocks entirely', () => {
    const chunker = new SentenceChunker();
    expect(chunker.feed('Here is code: ```js\nconsole.log("hi");\n``` and more text. ')).toEqual([
      'Here is code:  and more text.',
    ]);
  });

  it('strips inline code spans', () => {
    const chunker = new SentenceChunker();
    expect(chunker.feed('Use `npm install` to install. ')).toEqual(['Use  to install.']);
  });

  it('keeps the label only for markdown links', () => {
    const chunker = new SentenceChunker();
    expect(chunker.feed('Visit [hello](http://example.com) now. ')).toEqual(['Visit hello now.']);
  });

  it('handles unbalanced brackets without consuming text', () => {
    const chunker = new SentenceChunker();
    expect(chunker.feed('Brackets [unfinished without close. ')).toEqual([
      'Brackets [unfinished without close.',
    ]);
  });

  it('handles a bracketed phrase that is not a markdown link', () => {
    const chunker = new SentenceChunker();
    expect(chunker.feed('Here is [text] without parens. ')).toEqual([
      'Here is [text] without parens.',
    ]);
  });

  it('handles markdown link with an unclosed url paren by passing through', () => {
    const chunker = new SentenceChunker();
    expect(chunker.feed('See [label](http://broken without close. ')).toEqual([
      'See [label](http://broken without close.',
    ]);
  });

  it('handles unbalanced inline backticks by passing the orphan through', () => {
    const chunker = new SentenceChunker();
    expect(chunker.feed('Pretend `unfinished code at end of stream. ')).toEqual([
      'Pretend `unfinished code at end of stream.',
    ]);
  });

  it('feeds tokens one character at a time and emits a sentence after the boundary', () => {
    const chunker = new SentenceChunker();
    const result: string[] = [];
    for (const ch of 'Hi there. Bye now! ') {
      result.push(...chunker.feed(ch));
    }
    expect(result).toEqual(['Hi there.', 'Bye now!']);
  });

  it('treats end-of-stream boundary punctuation as a complete sentence', () => {
    const chunker = new SentenceChunker();
    // No trailing whitespace inside the buffer — punctuation followed by no char
    // means the next() lookup is undefined and that counts as end-of-stream.
    expect(chunker.feed('A complete sentence.')).toEqual(['A complete sentence.']);
  });

  it('does not treat punctuation followed by a non-whitespace character as a boundary', () => {
    const chunker = new SentenceChunker();
    expect(chunker.feed('Visit example.com today. ')).toEqual(['Visit example.com today.']);
  });

  it('toggles code-fence state across multiple feed() calls', () => {
    const chunker = new SentenceChunker();
    expect(chunker.feed('Before. ```code')).toEqual(['Before.']);
    // While in the fence, sentence punctuation inside is not emitted.
    expect(chunker.feed(' inside.')).toEqual([]);
    // Closing the fence and then adding plain text re-enables chunking.
    expect(chunker.feed('``` After. ')).toEqual(['After.']);
  });
});

describe('SentenceChunker.flush', () => {
  it('returns the remaining buffered text and clears the buffer', () => {
    const chunker = new SentenceChunker();
    chunker.feed('No boundary yet');
    expect(chunker.flush()).toBe('No boundary yet');
    // Flushing twice on an empty buffer is null.
    expect(chunker.flush()).toBeNull();
  });

  it('returns null when the buffer is empty', () => {
    const chunker = new SentenceChunker();
    expect(chunker.flush()).toBeNull();
  });

  it('returns null when the buffer is only whitespace', () => {
    const chunker = new SentenceChunker();
    chunker.feed('   ');
    expect(chunker.flush()).toBeNull();
  });

  it('returns the trimmed remainder after sentences have been emitted', () => {
    const chunker = new SentenceChunker();
    expect(chunker.feed('Done. Tail without boundary')).toEqual(['Done.']);
    expect(chunker.flush()).toBe('Tail without boundary');
  });
});
