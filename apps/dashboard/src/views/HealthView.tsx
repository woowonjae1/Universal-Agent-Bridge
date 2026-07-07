import { useCallback, useEffect, useState } from "react";
import { HeartPulse, RefreshCw } from "lucide-react";
import {
  requestJson,
  errorToMessage,
  type HealthResponse,
  type HealthRuntime
} from "../lib";

interface HealthViewProps {
  apiBase: string;
  refreshKey: number;
}

const CIRCUIT_LABEL: Record<string, string> = {
  closed: "Closed (healthy)",
  half_open: "Half-open (probing)",
  open: "Open (failing)"
};

export function HealthView({ apiBase, refreshKey }: HealthViewProps) {
  const [runtimes, setRuntimes] = useState<HealthRuntime[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await requestJson<HealthResponse>(`${apiBase}/health/runtimes`);
      setRuntimes(data.runtimes ?? []);
      setError(null);
    } catch (caught) {
      setError(errorToMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  return (
    <section className="cp-view single-column">
      <div className="cp-panel">
        <div className="cp-panel-head">
          <div>
            <h2>Runtime Health</h2>
            <p>GET /health/runtimes — circuit breaker + reported status</p>
          </div>
          <button className="icon-button" onClick={() => void load()} title="Refresh health">
            {loading ? <HeartPulse size={16} /> : <RefreshCw size={16} />}
          </button>
        </div>

        {error && <div className="cp-error">{error}</div>}

        <div className="health-grid">
          {runtimes.map((entry) => (
            <div className={`health-card ${entry.circuit.state}`} key={entry.runtime}>
              <div className="health-card-head">
                <strong>{entry.runtime}</strong>
                <span className={`circuit-pill ${entry.circuit.state}`}>
                  {entry.circuit.state}
                </span>
              </div>
              <div className="health-meta">
                <span>{CIRCUIT_LABEL[entry.circuit.state] ?? entry.circuit.state}</span>
                <span className="failure-count">
                  {entry.circuit.failures} failure(s)
                </span>
              </div>
              <pre className="reported">
                {entry.reported === null
                  ? "no reported health"
                  : JSON.stringify(entry.reported, null, 2)}
              </pre>
            </div>
          ))}
          {runtimes.length === 0 && !error && (
            <div className="empty-state large">No runtimes registered</div>
          )}
        </div>
      </div>
    </section>
  );
}
