import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  GitBranch,
  Play,
  RotateCcw,
  Ban,
  RefreshCw,
  ChevronRight
} from "lucide-react";
import {
  requestJson,
  errorToMessage,
  formatTime,
  type PlanRun,
  type PlanRunStep,
  type PlanRunListResponse
} from "../lib";

interface PlansViewProps {
  apiBase: string;
  refreshKey: number;
}

const EXAMPLE_PLAN = JSON.stringify(
  {
    id: "streaming_pipeline",
    mode: "dag",
    timeoutMs: 120000,
    stopOnError: true,
    steps: [
      {
        id: "generate",
        runtime: "openclaw",
        method: "agent",
        stream: true,
        params: {
          sessionKey: "uab_demo",
          prompt: "In exactly 3 sentences, explain what a multi-agent bridge does and why it matters."
        }
      },
      {
        id: "review",
        runtime: "openclaw",
        streamFrom: ["generate"],
        method: "agent",
        params: {
          sessionKey: "uab_review",
          prompt: "Rate the clarity of the following text 1–10 and explain your score in one sentence:\n\n${steps.generate.stream.text}"
        }
      }
    ]
  },
  null,
  2
);

const ACTIVE_STATUSES = new Set(["pending", "running"]);

export function PlansView({ apiBase, refreshKey }: PlansViewProps) {
  const [runs, setRuns] = useState<PlanRun[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [planText, setPlanText] = useState(EXAMPLE_PLAN);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<number | null>(null);

  const selected = useMemo(
    () => runs.find((run) => run.id === selectedId) ?? null,
    [runs, selectedId]
  );

  const hasActive = useMemo(
    () => runs.some((run) => ACTIVE_STATUSES.has(run.status)),
    [runs]
  );

  const loadRuns = useCallback(async () => {
    try {
      const data = await requestJson<PlanRunListResponse>(`${apiBase}/plans?limit=50`);
      setRuns(data.runs ?? []);
      setError(null);
    } catch (caught) {
      setError(errorToMessage(caught));
    }
  }, [apiBase]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns, refreshKey]);

  // Poll while any run is active so the DAG updates live.
  useEffect(() => {
    if (!hasActive) {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    if (pollRef.current) return;
    const hasStreaming = runs.some((run) =>
      run.steps.some((step) => step.status === "running" && step.streamText !== undefined)
    );
    pollRef.current = window.setInterval(() => {
      void loadRuns();
    }, hasStreaming ? 400 : 1200);
    return () => {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [hasActive, loadRuns]);

  async function submitPlan() {
    setBusy(true);
    setError(null);
    try {
      const plan = JSON.parse(planText);
      const data = await requestJson<{ run: PlanRun }>(`${apiBase}/plans`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(plan)
      });
      if (data.run) {
        setSelectedId(data.run.id);
      }
      await loadRuns();
    } catch (caught) {
      setError(errorToMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function actOnRun(runId: string, action: "cancel" | "resume") {
    setBusy(true);
    try {
      await requestJson(`${apiBase}/plans/${encodeURIComponent(runId)}/${action}`, {
        method: "POST"
      });
      await loadRuns();
    } catch (caught) {
      setError(errorToMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="cp-view plans-view">
      <div className="cp-column submit-column">
        <div className="cp-panel">
          <div className="cp-panel-head">
            <div>
              <h2>Submit Plan</h2>
              <p>POST /plans — durable DAG run</p>
            </div>
            <GitBranch size={18} aria-hidden="true" />
          </div>
          <textarea
            className="plan-editor"
            spellCheck={false}
            value={planText}
            onChange={(event) => setPlanText(event.target.value)}
          />
          <div className="cp-toolbar">
            <button className="primary-button" onClick={submitPlan} disabled={busy}>
              <Play size={16} aria-hidden="true" />
              Start run
            </button>
            <button
              className="secondary-button"
              onClick={() => setPlanText(EXAMPLE_PLAN)}
              disabled={busy}
            >
              <RotateCcw size={16} aria-hidden="true" />
              Reset
            </button>
          </div>
          {error && <div className="cp-error">{error}</div>}
        </div>

        <div className="cp-panel run-list-panel">
          <div className="cp-panel-head">
            <div>
              <h2>Recent Runs</h2>
              <p>{runs.length} run(s)</p>
            </div>
            <button className="icon-button" onClick={() => void loadRuns()} title="Refresh runs">
              <RefreshCw size={15} aria-hidden="true" />
            </button>
          </div>
          <div className="run-list">
            {runs.map((run) => (
              <button
                key={run.id}
                className={`run-row ${run.id === selectedId ? "active" : ""}`}
                onClick={() => setSelectedId(run.id)}
              >
                <span className={`status-pill ${run.status}`}>{run.status}</span>
                <span className="run-row-body">
                  <strong>{run.planId}</strong>
                  <small>{run.id}</small>
                </span>
                <span className="run-row-meta">
                  {run.steps.filter((step) => step.status === "success").length}/
                  {run.steps.length}
                </span>
              </button>
            ))}
            {runs.length === 0 && <div className="empty-state">No plan runs yet</div>}
          </div>
        </div>
      </div>

      <div className="cp-column detail-column">
        {selected ? (
          <PlanRunDetail run={selected} busy={busy} onAction={actOnRun} />
        ) : (
          <div className="cp-panel">
            <div className="empty-state large">
              Select a run to inspect its DAG, or submit a plan to start one.
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function PlanRunDetail(props: {
  run: PlanRun;
  busy: boolean;
  onAction: (runId: string, action: "cancel" | "resume") => void;
}) {
  const { run, busy, onAction } = props;
  const active = ACTIVE_STATUSES.has(run.status);
  const canResume = run.status === "failed" || run.status === "cancelled";

  return (
    <div className="cp-panel run-detail">
      <div className="cp-panel-head">
        <div>
          <h2>{run.planId}</h2>
          <p>
            {run.id} · trace {run.traceId}
          </p>
        </div>
        <span className={`status-pill ${run.status}`}>{run.status}</span>
      </div>

      <div className="run-detail-meta">
        <MetaItem label="Created" value={formatTime(run.createdAt)} />
        <MetaItem label="Updated" value={formatTime(run.updatedAt)} />
        <MetaItem label="Started" value={formatTime(run.startedAt)} />
        <MetaItem label="Completed" value={formatTime(run.completedAt)} />
      </div>

      <div className="cp-toolbar">
        <button
          className="secondary-button"
          onClick={() => onAction(run.id, "cancel")}
          disabled={busy || !active}
        >
          <Ban size={15} aria-hidden="true" />
          Cancel
        </button>
        <button
          className="secondary-button"
          onClick={() => onAction(run.id, "resume")}
          disabled={busy || !canResume}
        >
          <RotateCcw size={15} aria-hidden="true" />
          Resume
        </button>
      </div>

      {typeof run.error === "string" && run.error && (
        <div className="cp-error">{run.error}</div>
      )}

      <div className="dag">
        {run.steps
          .slice()
          .sort((a, b) => a.index - b.index)
          .map((step) => (
            <StepCard key={step.stepId} step={step} />
          ))}
      </div>

      {run.final && (
        <details className="final-response">
          <summary>Final response</summary>
          <pre>{JSON.stringify(run.final, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

function StepCard({ step }: { step: PlanRunStep }) {
  const [open, setOpen] = useState(false);
  const duration =
    step.startedAt && step.completedAt
      ? new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime()
      : null;

  return (
    <div className={`step-card ${step.status}`}>
      <button className="step-head" onClick={() => setOpen((value) => !value)}>
        <span className={`step-dot ${step.status}`} />
        <span className="step-title">
          <strong>{step.stepId}</strong>
          <small>{step.method}</small>
        </span>
        <span className="step-meta">
          {step.runtime && <span className="runtime-tag">{step.runtime}</span>}
          <span className={`status-tag ${step.status}`}>{step.status}</span>
          {duration !== null && <span className="dur-tag">{duration}ms</span>}
          <ChevronRight
            size={14}
            aria-hidden="true"
            className={`chevron ${open ? "open" : ""}`}
          />
        </span>
      </button>
      {(step.dependsOn.length > 0 || (step.streamFrom && step.streamFrom.length > 0)) && (
        <div className="depends-row">
          {step.dependsOn.length > 0 && (
            <>
              depends on{" "}
              {step.dependsOn.map((dep) => (
                <span key={dep} className="dep-tag">{dep}</span>
              ))}
            </>
          )}
          {step.streamFrom && step.streamFrom.length > 0 && (
            <>
              {step.dependsOn.length > 0 && " · "}
              stream from{" "}
              {step.streamFrom.map((dep) => (
                <span key={dep} className="dep-tag stream-tag">{dep}</span>
              ))}
            </>
          )}
        </div>
      )}
      {step.streamText && (
        <div className="stream-preview">
          <span className="io-label">{step.status === "running" ? "streaming…" : "streamed"}</span>
          <div className="stream-text">{step.streamText}</div>
        </div>
      )}
      {open && (
        <div className="step-body">
          {step.input !== undefined && (
            <div className="step-io">
              <span className="io-label">input</span>
              <pre>{JSON.stringify(step.input, null, 2)}</pre>
            </div>
          )}
          {step.response && (
            <div className="step-io">
              <span className="io-label">response</span>
              <pre>{JSON.stringify(step.response, null, 2)}</pre>
            </div>
          )}
          {step.input === undefined && !step.response && !step.streamText && (
            <div className="empty-state compact-empty">No output yet</div>
          )}
        </div>
      )}
    </div>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="meta-item">
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}
