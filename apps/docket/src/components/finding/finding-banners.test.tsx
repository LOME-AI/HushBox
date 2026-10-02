import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { makeFinding } from '@/test-utils/finding-fixture';
import { TEST_IDS } from '@/test-ids';
import { FindingBanners } from './finding-banners';

const corpus = [
  makeFinding({ id: 'AI-1', state: 'open' }),
  makeFinding({ id: 'AI-5', state: 'denied' }),
];

describe('FindingBanners', () => {
  it('says nothing about a finding with nothing attached to it', () => {
    const { container } = render(
      <FindingBanners finding={corpus[0]!} findings={corpus} onJump={vi.fn()} />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('flags a finding the audit marked a warning', () => {
    render(
      <FindingBanners
        finding={makeFinding({ id: 'AI-1', warning: true })}
        findings={corpus}
        onJump={vi.fn()}
      />
    );

    expect(screen.getByText(/read this one before ruling/)).toBeInTheDocument();
  });

  it('says a marked finding is owed a session of its own', () => {
    render(
      <FindingBanners
        finding={makeFinding({ id: 'AI-1', dedicated: true })}
        findings={corpus}
        onJump={vi.fn()}
      />
    );

    expect(screen.getByTestId(TEST_IDS.dedicatedBanner)).toBeInTheDocument();
  });

  it('says nothing about a session on an unmarked finding', () => {
    render(<FindingBanners finding={corpus[0]!} findings={corpus} onJump={vi.fn()} />);

    expect(screen.queryByTestId(TEST_IDS.dedicatedBanner)).not.toBeInTheDocument();
  });

  it('names the group and each partner in it', () => {
    render(
      <FindingBanners
        finding={makeFinding({ id: 'AI-1', group: 'AI-1 + AI-5' })}
        findings={corpus}
        onJump={vi.fn()}
      />
    );

    expect(screen.getByText('AI-1 + AI-5')).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.findingChip)).toHaveTextContent('AI-5');
  });

  it('jumps to a related finding', () => {
    const onJump = vi.fn();
    render(
      <FindingBanners
        finding={makeFinding({ id: 'AI-1', related: ['AI-5'] })}
        findings={corpus}
        onJump={onJump}
      />
    );

    fireEvent.click(screen.getByTestId(TEST_IDS.findingChip));

    expect(onJump).toHaveBeenCalledWith('AI-5');
  });

  it('names a finding that links here, which this one never linked back to', () => {
    const findings = [makeFinding({ id: 'AI-1' }), makeFinding({ id: 'AI-5', related: ['AI-1'] })];

    render(<FindingBanners finding={findings[0]!} findings={findings} onJump={vi.fn()} />);

    expect(screen.getByTestId(TEST_IDS.findingChip)).toHaveTextContent('AI-5');
  });

  it('keeps a link this finding declared apart from one declared about it', () => {
    const findings = [
      makeFinding({ id: 'AI-1', related: ['AI-9'] }),
      makeFinding({ id: 'AI-5', related: ['AI-1'] }),
      makeFinding({ id: 'AI-9' }),
    ];

    render(<FindingBanners finding={findings[0]!} findings={findings} onJump={vi.fn()} />);

    expect(screen.getByText('Links to').closest('div')).toHaveTextContent('AI-9');
    expect(screen.getByText('Linked from').closest('div')).toHaveTextContent('AI-5');
  });

  it('carries a link both findings declared on the declaring side only', () => {
    const findings = [
      makeFinding({ id: 'AI-1', related: ['AI-5'] }),
      makeFinding({ id: 'AI-5', related: ['AI-1'] }),
    ];

    render(<FindingBanners finding={findings[0]!} findings={findings} onJump={vi.fn()} />);

    expect(screen.getAllByTestId(TEST_IDS.findingChip)).toHaveLength(1);
    expect(screen.queryByText('Linked from')).not.toBeInTheDocument();
  });

  it('leaves out a link from a group partner, the group already carrying it', () => {
    const findings = [
      makeFinding({ id: 'AI-1', group: 'AI-1 + AI-5' }),
      makeFinding({ id: 'AI-5', related: ['AI-1'] }),
    ];

    render(<FindingBanners finding={findings[0]!} findings={findings} onJump={vi.fn()} />);

    expect(screen.getAllByTestId(TEST_IDS.findingChip)).toHaveLength(1);
    expect(screen.queryByText('Linked from')).not.toBeInTheDocument();
  });
});
