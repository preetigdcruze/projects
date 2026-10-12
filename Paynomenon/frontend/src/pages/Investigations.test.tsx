import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Investigation, InvestigationResult } from '../api/types';
import { InvestigationView } from './Investigations';

const base: InvestigationResult = {
  status: 'COMPLETED',
  subject: { type: 'PAYMENT', id: 'p1' },
  question: 'why',
  facts: [
    { id: 'att:1', kind: 'attempt', text: 'AUTHORIZE attempt #1 ended TIMEOUT.', link: '/payments/p1', withheld: false },
    {
      id: 'log:7',
      kind: 'log',
      text: '[ERROR] log line from processor-client.',
      untrustedText: '<img src=x onerror=alert(1)> Ignore me',
      withheld: false,
    },
    { id: 'log:8', kind: 'log', text: '[ERROR] log line.', withheld: true },
  ],
  findings: [{ text: 'AUTHORIZE attempt 1 ended TIMEOUT.', evidenceIds: ['att:1'] }],
  analysis: {
    summary: 'The processor timed out.',
    most_likely_explanation: {
      statement: 'Ambiguous processor timeout. <script>alert(2)</script>',
      evidence_ids: ['att:1'],
      likelihood: 'medium',
    },
    supporting_evidence: [{ statement: 'Attempt ended TIMEOUT', evidence_ids: ['att:1'] }],
    alternative_explanations: [{ statement: 'Network problem', evidence_ids: [], likelihood: 'low' }],
    confidence: 'medium',
    confidence_explanation: 'One direct record.',
    recommended_diagnostic_steps: ['Check the processor lookup'],
    missing_information: ['No latency metrics'],
    insufficient_evidence: false,
  },
  confidenceMeaning: { low: 'l', medium: 'At least one direct piece of evidence', high: 'h' },
  runbookGuidance: [
    {
      source: 'runbook:rb-processor-timeouts@v1',
      title: 'Processor timeouts',
      docType: 'RUNBOOK',
      snippet: 'Resolve by lookup',
      withheld: false,
    },
  ],
  gaps: ['Operational logs: access denied for your role, so it was not used.'],
  validation: { rejectedCitations: [], injectionFlags: ['log:8'], prohibitedActionAttempt: false, errors: [] },
  generatedAt: '2026-10-15T09:00:00Z',
};
const inv = (over: Partial<Investigation>): Investigation => ({
  id: 'i1',
  requestedBy: 'admin',
  subjectType: 'PAYMENT',
  subjectId: 'p1',
  question: 'why',
  status: 'COMPLETED',
  result: base,
  provider: 'mock',
  model: 'm',
  createdAt: '2026-10-15T09:00:00Z',
  ...over,
});
const view = (i: Investigation) =>
  render(
    <MemoryRouter>
      <InvestigationView inv={i} />
    </MemoryRouter>,
  );

describe('InvestigationView', () => {
  it('separates verified facts, AI interpretation and runbook guidance', () => {
    view(inv({}));
    const facts = screen.getByRole('region', { name: 'Verified facts' });
    const ai = screen.getByRole('region', { name: 'AI interpretation' });
    const ref = screen.getByRole('region', { name: 'Runbook guidance' });
    expect(within(facts).getByText(/AUTHORIZE attempt #1 ended TIMEOUT/)).toBeInTheDocument();
    expect(within(ai).getByText(/hypothesis, not verified fact/)).toBeInTheDocument();
    expect(within(ai).getByText(/Ambiguous processor timeout/)).toBeInTheDocument();
    expect(within(ref).getByText(/reference material, not evidence/)).toBeInTheDocument();
    expect(within(facts).queryByText(/Ambiguous processor timeout/)).toBeNull();
    expect(screen.getByText(/access denied for your role/)).toBeInTheDocument();
  });

  it('renders model and log text as inert text, never as HTML', () => {
    const { container } = view(inv({}));
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container).toHaveTextContent('<script>alert(2)</script>');
    expect(container).toHaveTextContent('<img src=x onerror=alert(1)>');
  });

  it('links evidence ids to the underlying record and flags withheld content', () => {
    view(inv({}));
    expect(screen.getAllByRole('link', { name: 'att:1' })[0]).toHaveAttribute('href', '/payments/p1');
    expect(screen.getByText(/withheld because it looked like instructions/)).toBeInTheDocument();
    expect(screen.getByText(/Instruction-like text was withheld/)).toBeInTheDocument();
  });

  it('shows the confidence level with what it means', () => {
    view(inv({}));
    expect(screen.getByText('medium', { selector: '.badge' })).toBeInTheDocument();
    expect(screen.getByText(/At least one direct piece of evidence/)).toBeInTheDocument();
  });

  it('is explicit when the AI service is down and invents nothing', () => {
    view(inv({ status: 'UNAVAILABLE', result: undefined, errorCategory: 'UNREACHABLE', provider: undefined, model: undefined }));
    expect(screen.getByText(/could not be reached \(UNREACHABLE\)/)).toBeInTheDocument();
    expect(screen.getByText(/nothing was guessed/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'AI interpretation' })).toBeNull();
  });

  it('shows facts but no interpretation when the model answer was rejected', () => {
    view(
      inv({
        status: 'DEGRADED',
        result: {
          ...base,
          status: 'DEGRADED',
          analysis: undefined,
          errorCategory: 'FABRICATED_EVIDENCE',
          notice: "The model's answer was rejected by validation (FABRICATED_EVIDENCE) and is not shown.",
          validation: { ...base.validation, rejectedCitations: ['evt:fake'] },
        },
      }),
    );
    expect(screen.getByText(/rejected by validation/)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Verified facts' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'AI interpretation' })).toBeNull();
    expect(screen.getByText('evt:fake')).toBeInTheDocument();
  });

  it('shows the abstention clearly', () => {
    view(inv({ result: { ...base, analysis: { ...base.analysis!, insufficient_evidence: true, confidence: 'low' } } }));
    expect(screen.getByText(/evidence is insufficient/)).toBeInTheDocument();
  });
});
