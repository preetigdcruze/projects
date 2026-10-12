import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Banner, DataState, ErrorBanner, EvidenceChip, Spinner, StatusBadge } from '../components/ui';
import { formatDateTime, formatMoney, shortId } from '../format';
import { useAsync } from '../hooks';
import type { AnalyticsAnswer, Investigation, InvestigationResult } from '../api/types';

type Subject = 'PAYMENT' | 'INCIDENT' | 'ANOMALY';
const QUESTIONS: Record<Subject, string[]> = {
  PAYMENT: [
    'Why did this payment end up in this state?',
    'Was the customer charged, and how do we know?',
    'What should I check next?',
  ],
  INCIDENT: ['What is going on in this incident and what is the likely cause?'],
  ANOMALY: ['What could explain this anomaly?'],
};
const ANALYTICS_EXAMPLES = [
  'Why did payment failures increase in the last hour?',
  'Which processor has the highest failure rate today?',
  'What are the most common causes of failed payments?',
  'Are any services showing unusual latency?',
  'Which reconciliation discrepancies require investigation?',
];

export function Investigations() {
  const [tab, setTab] = useState<'investigate' | 'analytics' | 'runbooks'>('investigate');
  const status = useAsync(() => api.providerStatus(), [], 30000);
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>AI Investigation</h1>
          <span className="muted small">
            Read-only assistant: it explains and recommends; it can never authorize, capture, refund or change anything.
          </span>
        </div>
        <ProviderBadge status={status.data} error={status.error} />
      </div>
      <div className="tabs" role="tablist">
        {(['investigate', 'analytics', 'runbooks'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={`tab${tab === t ? ' active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t === 'investigate' ? 'Investigate' : t === 'analytics' ? 'Ask analytics' : 'Ask runbooks'}
          </button>
        ))}
      </div>
      {tab === 'investigate' && <InvestigateTab />}
      {tab === 'analytics' && <AnalyticsTab />}
      {tab === 'runbooks' && <RunbookTab />}
    </div>
  );
}

function ProviderBadge({
  status,
  error,
}: {
  status?: { status: string; provider?: string; model?: string; recentErrorCategories?: Record<string, number> };
  error?: unknown;
}) {
  if (error) return <span className="badge bad">AI status unknown</span>;
  if (!status) return null;
  const cls = status.status === 'OK' ? 'ok' : status.status === 'UNAVAILABLE' ? 'bad' : 'warn';
  const errs = Object.entries(status.recentErrorCategories ?? {});
  return (
    <span className="small" data-testid="provider-badge">
      <span className={`badge ${cls}`}>AI provider: {status.status}</span>{' '}
      <span className="muted">
        {status.provider} {status.model}
      </span>
      {errs.length > 0 && <div className="muted">recent errors: {errs.map(([k, v]) => `${k}×${v}`).join(', ')}</div>}
    </span>
  );
}

function InvestigateTab() {
  const { can } = useAuth();
  const [params] = useSearchParams();
  const [subjectType, setSubjectType] = useState<Subject>((params.get('subjectType') as Subject) || 'PAYMENT');
  const [subjectId, setSubjectId] = useState(params.get('subjectId') ?? '');
  const [question, setQuestion] = useState(QUESTIONS[subjectType][0]!);
  const [run, setRun] = useState<{ busy: boolean; error?: unknown; result?: Investigation }>({ busy: false });

  const options = useAsync(async () => {
    if (subjectType === 'PAYMENT') {
      const [failed, uncertain, recent] = await Promise.all([
        api.payments({ status: 'FAILED', size: 8 }),
        api.payments({ status: 'UNCERTAIN', size: 8 }),
        api.payments({ size: 8 }),
      ]);
      const seen = new Set<string>();
      return [...failed.items, ...uncertain.items, ...recent.items]
        .filter((p) => !seen.has(p.id) && seen.add(p.id))
        .map((p) => ({
          id: p.id,
          label: `${shortId(p.id)} · ${p.status} · ${formatMoney(p.amount, p.currency)} · ${p.processor}`,
        }));
    }
    if (subjectType === 'INCIDENT')
      return (await api.incidents({ size: 20 })).items.map((i) => ({ id: i.id, label: `${i.status} · ${i.title}` }));
    return (await api.anomalies({ size: 20 })).items.map((a) => ({
      id: a.id,
      label: `${a.severity} · ${a.metric} on ${a.dimension}`,
    }));
  }, [subjectType]);

  const history = useAsync(
    () => (subjectId ? api.investigations({ subjectType, subjectId, size: 5 }) : Promise.resolve(undefined)),
    [subjectType, subjectId, run.result?.id],
  );

  useEffect(() => setQuestion(QUESTIONS[subjectType][0]!), [subjectType]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setRun({ busy: true });
    try {
      setRun({ busy: false, result: await api.investigate(subjectType, subjectId.trim(), question) });
    } catch (err) {
      setRun({ busy: false, error: err });
    }
  }

  if (!can('INVESTIGATOR'))
    return (
      <Banner kind="warn">
        Running investigations requires the INVESTIGATOR role. You can still review past investigations from payment and incident
        pages.
      </Banner>
    );

  return (
    <div className="stack">
      <form className="card stack" onSubmit={submit} aria-label="Run investigation">
        <div className="form-grid">
          <label>
            Subject type
            <select
              value={subjectType}
              onChange={(e) => {
                setSubjectType(e.target.value as Subject);
                setSubjectId('');
              }}
            >
              <option value="PAYMENT">Payment</option>
              <option value="INCIDENT">Incident</option>
              <option value="ANOMALY">Anomaly</option>
            </select>
          </label>
          <label>
            Pick one
            <select value={subjectId} onChange={(e) => setSubjectId(e.target.value)} aria-label="Pick subject">
              <option value="">Select…</option>
              {(options.data ?? []).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            …or paste an ID
            <input value={subjectId} onChange={(e) => setSubjectId(e.target.value)} placeholder="uuid" aria-label="Subject id" />
          </label>
        </div>
        <label>
          Question
          <textarea value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={1000} aria-label="Question" />
        </label>
        <div className="row">
          {QUESTIONS[subjectType].map((q) => (
            <button type="button" key={q} onClick={() => setQuestion(q)} className="small">
              {q}
            </button>
          ))}
        </div>
        <div className="row">
          <button
            className="primary"
            disabled={run.busy || !/^[0-9a-f-]{36}$/i.test(subjectId.trim()) || question.trim().length < 3}
          >
            {run.busy ? 'Investigating…' : 'Run investigation'}
          </button>
          {run.busy && <Spinner label="Gathering evidence and asking the model" />}
        </div>
      </form>

      {run.error ? <ErrorBanner error={run.error} /> : null}
      {run.result && <InvestigationView inv={run.result} />}

      {subjectId && (
        <div className="card">
          <h2>Investigation history for this subject</h2>
          <DataState
            data={history.data}
            loading={history.loading}
            error={history.error}
            reload={history.reload}
            isEmpty={(h) => !h || h.items.length === 0}
            empty="No earlier investigations."
          >
            {(h) => (
              <ul className="tight">
                {h!.items.map((i) => (
                  <li key={i.id}>
                    <StatusBadge status={i.status} /> {formatDateTime(i.createdAt)} · {i.requestedBy} · “{i.question}”{' '}
                    <button className="small" onClick={() => setRun({ busy: false, result: i })}>
                      Open
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </DataState>
        </div>
      )}
    </div>
  );
}

export function InvestigationView({ inv }: { inv: Investigation }) {
  const r = inv.result;
  return (
    <div className="stack" aria-label="Investigation result" data-testid="investigation-result">
      <div className="card row between">
        <span>
          <StatusBadge status={inv.status} />{' '}
          <span className="muted small">
            {inv.provider ? `${inv.provider} · ${inv.model}` : 'no model used'} · {inv.latencyMs ?? '—'} ms
            {inv.promptTokens !== undefined ? ` · ${inv.promptTokens}+${inv.completionTokens ?? 0} tokens` : ''}
          </span>
        </span>
        <span className="muted small">{formatDateTime(inv.completedAt ?? inv.createdAt)}</span>
      </div>

      {inv.status === 'UNAVAILABLE' && (
        <Banner kind="bad">
          <strong>The AI service could not be reached ({inv.errorCategory ?? 'unknown'}).</strong> No analysis was generated and
          nothing was guessed. Payments, dashboards and reconciliation are unaffected. Try again later.
        </Banner>
      )}
      {inv.status === 'FAILED' && (
        <Banner kind="bad">The AI service returned an unusable response; nothing was generated.</Banner>
      )}
      {r?.notice && (
        <Banner kind="warn">
          <strong>Degraded result.</strong> {r.notice}
        </Banner>
      )}

      {r && <ResultBody r={r} />}
    </div>
  );
}

function ResultBody({ r }: { r: InvestigationResult }) {
  const links = new Map(r.facts.map((f) => [f.id, f.link]));
  const cites = (ids: string[]) => ids.map((id) => <EvidenceChip key={id} id={id} link={links.get(id)} />);
  const a = r.analysis;
  return (
    <>
      <section className="card panel-fact" aria-label="Verified facts">
        <h2>
          Verified facts <span className="badge ok">retrieved from the system</span>
        </h2>
        {r.facts.length === 0 ? (
          <div className="empty">No records were retrieved.</div>
        ) : (
          <ul className="tight">
            {r.facts.map((f) => (
              <li key={f.id} id={`fact-${f.id}`}>
                <EvidenceChip id={f.id} link={f.link} /> {f.text}
                {f.withheld && (
                  <div className="small muted">
                    ⚠ Text from this record was withheld because it looked like instructions to the AI.
                  </div>
                )}
                {f.untrustedText && !f.withheld && (
                  <div className="small muted">Untrusted text, shown as plain text: “{f.untrustedText}”</div>
                )}
              </li>
            ))}
          </ul>
        )}
        {r.findings.length > 0 && (
          <>
            <h3>
              Rule-based findings <span className="muted small">(deterministic, no AI)</span>
            </h3>
            <ul className="tight">
              {r.findings.map((f, i) => (
                <li key={i}>
                  {f.text} {cites(f.evidenceIds)}
                </li>
              ))}
            </ul>
          </>
        )}
        {r.gaps.length > 0 && (
          <>
            <h3>What could not be retrieved</h3>
            <ul className="tight">
              {r.gaps.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
          </>
        )}
      </section>

      {a ? (
        <section className="card panel-ai" aria-label="AI interpretation">
          <h2>
            AI-generated interpretation <span className="badge unc">hypothesis, not verified fact</span>
          </h2>
          {a.insufficient_evidence && (
            <Banner kind="warn">
              <strong>The evidence is insufficient to explain this.</strong> The model declined to guess.
            </Banner>
          )}
          <p>
            <strong>{a.summary}</strong>
          </p>
          <h3>Most likely explanation</h3>
          <p>
            {a.most_likely_explanation.statement} {cites(a.most_likely_explanation.evidence_ids)}
          </p>
          <p>
            Confidence:{' '}
            <span className={`badge ${a.confidence === 'high' ? 'ok' : a.confidence === 'medium' ? 'warn' : ''}`}>
              {a.confidence}
            </span>{' '}
            <span className="muted small">{r.confidenceMeaning[a.confidence]}</span>
            <br />
            <span className="small">{a.confidence_explanation}</span>
          </p>
          {a.supporting_evidence.length > 0 && (
            <>
              <h3>Supporting evidence</h3>
              <ul className="tight">
                {a.supporting_evidence.map((c, i) => (
                  <li key={i}>
                    {c.statement} {cites(c.evidence_ids)}
                  </li>
                ))}
              </ul>
            </>
          )}
          {a.alternative_explanations.length > 0 && (
            <>
              <h3>Alternative explanations</h3>
              <ul className="tight">
                {a.alternative_explanations.map((c, i) => (
                  <li key={i}>
                    {c.statement} <span className="badge">{c.likelihood}</span> {cites(c.evidence_ids)}
                  </li>
                ))}
              </ul>
            </>
          )}
          {a.recommended_diagnostic_steps.length > 0 && (
            <>
              <h3>Recommended diagnostic steps</h3>
              <ol className="tight">
                {a.recommended_diagnostic_steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            </>
          )}
          {a.missing_information.length > 0 && (
            <>
              <h3>Missing information</h3>
              <ul className="tight">
                {a.missing_information.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </>
          )}
        </section>
      ) : (
        <Banner kind="info">No AI interpretation is shown for this result. The verified facts above are still accurate.</Banner>
      )}

      {r.runbookGuidance.length > 0 && (
        <section className="card panel-ref" aria-label="Runbook guidance">
          <h2>
            Runbook guidance <span className="badge warn">reference material, not evidence about this case</span>
          </h2>
          <ul className="tight">
            {r.runbookGuidance.map((g) => (
              <li key={g.source}>
                <span className="chip">{g.source}</span> <strong>{g.title}</strong>
                {g.withheld ? (
                  <span className="muted"> — excerpt withheld (instruction-like text)</span>
                ) : (
                  <div className="small muted">{g.snippet}</div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {(r.validation.rejectedCitations.length > 0 ||
        r.validation.injectionFlags.length > 0 ||
        r.validation.errors.length > 0) && (
        <section className="card" aria-label="Safety checks">
          <h2>Safety checks</h2>
          <ul className="tight">
            {r.validation.injectionFlags.length > 0 && (
              <li>
                Instruction-like text was withheld from the model in:{' '}
                {r.validation.injectionFlags.map((x) => (
                  <span key={x} className="chip">
                    {x}
                  </span>
                ))}
              </li>
            )}
            {r.validation.rejectedCitations.length > 0 && (
              <li>
                The model cited records that do not exist, so its answer was rejected:{' '}
                {r.validation.rejectedCitations.map((x) => (
                  <span key={x} className="chip">
                    {x}
                  </span>
                ))}
              </li>
            )}
            {r.validation.prohibitedActionAttempt && (
              <li>The model output referred to an action it cannot perform; it was rejected.</li>
            )}
            {r.validation.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function AnalyticsTab() {
  const [q, setQ] = useState(ANALYTICS_EXAMPLES[0]!);
  const [state, setState] = useState<{ busy: boolean; error?: unknown; answer?: AnalyticsAnswer }>({ busy: false });
  async function ask(e: FormEvent) {
    e.preventDefault();
    setState({ busy: true });
    try {
      setState({ busy: false, answer: await api.analyticsQuery(q) });
    } catch (err) {
      setState({ busy: false, error: err });
    }
  }
  const a = state.answer;
  return (
    <div className="stack">
      <form className="card stack" onSubmit={ask} aria-label="Ask analytics">
        <label>
          Question about payments, processors or reconciliation
          <textarea value={q} onChange={(e) => setQ(e.target.value)} maxLength={500} />
        </label>
        <div className="row">
          {ANALYTICS_EXAMPLES.map((x) => (
            <button type="button" className="small" key={x} onClick={() => setQ(x)}>
              {x}
            </button>
          ))}
        </div>
        <div className="row">
          <button className="primary" disabled={state.busy || q.trim().length < 3}>
            {state.busy ? 'Asking…' : 'Ask'}
          </button>
          {state.busy && <Spinner />}
        </div>
        <p className="muted small">
          The question is translated into a fixed set of predefined, parameterised queries. Numbers always come from those
          queries, never from the model.
        </p>
      </form>
      {state.error ? <ErrorBanner error={state.error} /> : null}
      {a?.status === 'UNAVAILABLE' && (
        <Banner kind="bad">{a.message ?? 'The AI service is unavailable.'} Dashboards and the analytics API still work.</Banner>
      )}
      {a?.status === 'UNSUPPORTED' && (
        <Banner kind="warn">
          {a.notice} Supported operations: {a.supportedOperations?.join(', ')}.
        </Banner>
      )}
      {a && a.status !== 'UNAVAILABLE' && a.status !== 'UNSUPPORTED' && (
        <div className="card stack" data-testid="analytics-answer">
          {a.notice && <Banner kind="warn">{a.notice}</Banner>}
          <div>
            <StatusBadge status={a.status} />{' '}
            <span className="badge">
              {a.explanationSource === 'llm' ? `explained by ${a.provider}` : 'template explanation (no AI)'}
            </span>
            <p style={{ marginTop: 10 }}>{a.explanation ?? 'No explanation available.'}</p>
          </div>
          <div className="small muted">
            Time range: {a.timeRange ? `${formatDateTime(a.timeRange.from)} → ${formatDateTime(a.timeRange.to)}` : '—'} · Metrics:{' '}
            {a.metricsUsed?.join(', ')} ·{' '}
            {a.dashboardLink && <Link to={a.dashboardLink.split('?')[0] ?? '/'}>Open dashboard view</Link>}
          </div>
          <div>
            <h3>Queries run</h3>
            <ul className="tight">
              {a.operations?.map((o) => (
                <li key={o.id}>
                  <code>{o.id}</code> {o.name}{' '}
                  <span className="muted small">
                    {o.endpoint} · {JSON.stringify(o.args)}
                  </span>
                </li>
              ))}
            </ul>
            <h3>Raw results</h3>
            {Object.entries(a.results ?? {}).map(([id, r]) => (
              <details key={id}>
                <summary>
                  {id}: {r.name}
                </summary>
                <pre className="mono small" style={{ overflow: 'auto' }}>
                  {JSON.stringify(r.data, null, 2)}
                </pre>
              </details>
            ))}
          </div>
          {(a.gaps?.length ?? 0) > 0 && <Banner kind="warn">Some queries were not run: {a.gaps!.join('; ')}</Banner>}
        </div>
      )}
    </div>
  );
}

function RunbookTab() {
  const [q, setQ] = useState('What should I do when a processor times out?');
  const [state, setState] = useState<{ busy: boolean; error?: unknown; answer?: Record<string, unknown> }>({ busy: false });
  async function ask(e: FormEvent) {
    e.preventDefault();
    setState({ busy: true });
    try {
      setState({ busy: false, answer: await api.runbookQuestion(q) });
    } catch (err) {
      setState({ busy: false, error: err });
    }
  }
  const a = state.answer as
    | {
        status?: string;
        answer?: string;
        notice?: string;
        guidance?: { source: string; title: string; snippet: string; withheld: boolean }[];
      }
    | undefined;
  return (
    <div className="stack">
      <form className="card stack" onSubmit={ask} aria-label="Ask runbooks">
        <label>
          Question
          <input value={q} onChange={(e) => setQ(e.target.value)} maxLength={500} />
        </label>
        <div>
          <button className="primary" disabled={state.busy || q.trim().length < 3}>
            {state.busy ? 'Searching…' : 'Search runbooks'}
          </button>
        </div>
      </form>
      {state.error ? <ErrorBanner error={state.error} /> : null}
      {a?.status === 'UNAVAILABLE' && (
        <Banner kind="bad">The AI service is unavailable. Runbooks can still be read in the repository docs.</Banner>
      )}
      {a && a.status !== 'UNAVAILABLE' && (
        <div className="card panel-ref stack">
          {a.notice && <Banner kind="warn">{a.notice}</Banner>}
          {a.answer && (
            <p>
              <strong>Summary of guidance:</strong> {a.answer}
            </p>
          )}
          {(a.guidance ?? []).map((g) => (
            <div key={g.source}>
              <span className="chip">{g.source}</span> <strong>{g.title}</strong>
              <div className="small muted">{g.withheld ? 'Excerpt withheld.' : g.snippet}</div>
            </div>
          ))}
          {(a.guidance ?? []).length === 0 && <div className="empty">No matching runbook.</div>}
          <p className="small muted">
            Runbook text is reference guidance written for humans. It is not evidence about any specific incident and is never
            executed.
          </p>
        </div>
      )}
    </div>
  );
}
