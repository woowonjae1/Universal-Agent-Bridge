import { useCallback, useEffect, useState } from "react";
import { Gauge, RefreshCw, Search } from "lucide-react";
import {
  requestJson,
  errorToMessage,
  formatDuration,
  type MetricsResponse,
  type TraceResponse
} from "../lib";

interface MetricsViewProps {
  apiBase: string;
  refreshKey: number;
}

export function MetricsView({ apiBase, refreshKey }: MetricsViewProps) {
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [traceId, setTraceId] = useState("");
  const [trace, setTrace] = useState<TraceResponse | null>(null);
  const [traceError, setTraceError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await requestJson<MetricsResponse>(`${apiBase}/metrics`);
      setMetrics(data);
      setError(null);
    } catch (caught) {
      setError(errorToMessage(caught));
    }
  }, [apiBase]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function lookupTrace() {
    if (!traceId.trim()) return;
    setTraceError(null);
    try {
      const data = await requestJson<TraceResponse>(
        `${apiBase}/traces/${encodeURIComponent(traceId.trim())}`
      );
      setTrace(data);
    } catch (caught) {
      setTrace(null);
      setTraceError(errorToMessage(caught));
    }
  }

  const errorRate =
    metrics && metrics.calls > 0
      ? ((metrics.errors / metrics.calls) * 100).toFixed(1)
      : "0.0";

  return (
    <section className="cp-view metrics-view">
      <div className="cp-panel">
        <div className="cp-panel-head">
          <div>
            <h2>Bridge Metrics</h2>
            <p>GET /metrics — calls, errors, latency, concurrency</p>
          </div>
          <button className="icon-button" onClick={() => void load()} title="Refresh metrics">
            <RefreshCw size={16} aria-hidden="true" />
          </button>
        </div>

        {error && <div className="cp-error">{error}</div>}

        {metrics && (
          <>
            <div className="stat-grid">
              <Stat label="Total calls" value={String(metrics.calls)} />
              <Stat label="Errors" value={String(metrics.errors)} tone={metrics.errors > 0 ? "red" : undefined} />
              <Stat label="Error rate" value={`${errorRate}%`} tone={Number(errorRate) > 0 ? "orange" : undefined} />
              <Stat label="Active" value={String(metrics.activeCalls)} tone={metrics.activeCalls > 0 ? "blue" : undefined} />
              <Stat label="Avg duration" value={formatDuration(metrics.avgDurationMs)} />
              <Stat label="Max duration" value={formatDuration(metrics.maxDurationMs)} />
              <Stat label="Uptime" value={formatDuration(metrics.uptimeMs)} />
            </div>

            <h3 className="cp-subhead">Per-runtime</h3>
            <div className="metrics-table-wrap">
              <table className="metrics-table">
                <thead>
                  <tr>
                    <th>Runtime</th>
                    <th>Calls</th>
                    <th>Errors</th>
                    <th>Avg</th>
                    <th>Max</th>
                    <th>Active</th>
                    <th>Queued</th>
                    <th>Limit</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.runtimes.map((runtime) => {
                    const concurrency = metrics.runtimeConcurrency[runtime.runtime];
                    return (
                      <tr key={runtime.runtime}>
                        <td>{runtime.runtime}</td>
                        <td>{runtime.calls}</td>
                        <td className={runtime.errors > 0 ? "cell-error" : ""}>{runtime.errors}</td>
                        <td>
                          {formatDuration(
                            runtime.calls > 0 ? runtime.totalDurationMs / runtime.calls : 0
                          )}
                        </td>
                        <td>{formatDuration(runtime.maxDurationMs)}</td>
                        <td>{concurrency?.active ?? 0}</td>
                        <td>{concurrency?.queued ?? 0}</td>
                        <td>{concurrency?.max ?? "∞"}</td>
                      </tr>
                    );
                  })}
                  {metrics.runtimes.length === 0 && (
                    <tr>
                      <td colSpan={8} className="empty-cell">
                        No calls recorded yet
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <div className="cp-panel">
        <div className="cp-panel-head">
          <div>
            <h2>Trace Lookup</h2>
            <p>GET /traces/{"{traceId}"} — audit + resources for one trace</p>
          </div>
          <Search size={18} aria-hidden="true" />
        </div>
        <div className="trace-form">
          <input
            value={traceId}
            placeholder="trace id"
            onChange={(event) => setTraceId(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void lookupTrace();
            }}
          />
          <button className="secondary-button" onClick={() => void lookupTrace()}>
            <Search size={15} aria-hidden="true" />
            Lookup
          </button>
        </div>
        {traceError && <div className="cp-error">{traceError}</div>}
        {trace && (
          <div className="trace-result">
            <div className="trace-line">
              <strong>{trace.audit.length}</strong> audit entr(ies) ·{" "}
              <strong>{trace.resources.length}</strong> resource(s)
            </div>
            {trace.audit.map((entry) => (
              <div className={`trace-audit ${entry.status}`} key={entry.id}>
                <span className={`status-tag ${entry.status}`}>{entry.status}</span>
                <span className="trace-audit-body">
                  <strong>
                    {entry.runtime}.{entry.method}
                  </strong>
                  <small>
                    {entry.durationMs}ms · {entry.message ?? entry.requestId}
                  </small>
                </span>
              </div>
            ))}
            {trace.audit.length === 0 && (
              <div className="empty-state compact-empty">No audit entries for this trace</div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function Stat(props: { label: string; value: string; tone?: string }) {
  return (
    <div className={`stat-card ${props.tone ?? ""}`}>
      <small>{props.label}</small>
      <strong>{props.value}</strong>
    </div>
  );
}
