import { useEffect, useMemo, useState } from "react";
import { Radio, Send } from "lucide-react";
import {
  requestJson,
  errorToMessage,
  type BroadcastResponse,
  type RuntimeSummary
} from "../lib";

interface BroadcastViewProps {
  apiBase: string;
}

interface RuntimesResponse {
  runtimes: RuntimeSummary[];
}

export function BroadcastView({ apiBase }: BroadcastViewProps) {
  const [capability, setCapability] = useState("");
  const [method, setMethod] = useState("status");
  const [params, setParams] = useState("{}");
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [result, setResult] = useState<BroadcastResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    async function loadCapabilities() {
      try {
        const data = await requestJson<RuntimesResponse>(`${apiBase}/runtimes`);
        const names = new Set<string>();
        for (const runtime of data.runtimes ?? []) {
          for (const name of Object.keys(runtime.capabilities ?? {})) {
            names.add(name);
          }
        }
        const sorted = [...names].sort();
        setCapabilities(sorted);
        setCapability((current) => current || sorted[0] || "");
      } catch {
        // Non-fatal: capability suggestions are optional.
      }
    }
    void loadCapabilities();
  }, [apiBase]);

  const matchCount = useMemo(
    () => (result ? result.results.length : null),
    [result]
  );

  async function broadcast() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const parsedParams = params.trim() ? JSON.parse(params) : {};
      const data = await requestJson<BroadcastResponse>(`${apiBase}/broadcast`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          capability,
          request: {
            jsonrpc: "2.0",
            id: `bc_${Date.now().toString(36)}`,
            method,
            params: parsedParams,
            meta: { source: "dashboard" }
          }
        })
      });
      setResult(data);
    } catch (caught) {
      setError(errorToMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="cp-view broadcast-view">
      <div className="cp-panel">
        <div className="cp-panel-head">
          <div>
            <h2>Broadcast</h2>
            <p>POST /broadcast — fan one request out to every runtime with a capability</p>
          </div>
          <Radio size={18} aria-hidden="true" />
        </div>

        <div className="form-grid">
          <label>
            <span>Capability</span>
            <input
              list="broadcast-capabilities"
              value={capability}
              onChange={(event) => setCapability(event.target.value)}
              placeholder="chat"
            />
            <datalist id="broadcast-capabilities">
              {capabilities.map((name) => (
                <option value={name} key={name} />
              ))}
            </datalist>
          </label>
          <label>
            <span>Method</span>
            <input
              value={method}
              onChange={(event) => setMethod(event.target.value)}
              placeholder="status"
            />
          </label>
        </div>

        <label className="json-field">
          <span>Params</span>
          <textarea
            className="plan-editor small"
            spellCheck={false}
            value={params}
            onChange={(event) => setParams(event.target.value)}
          />
        </label>

        <div className="cp-toolbar">
          <button
            className="primary-button"
            onClick={broadcast}
            disabled={busy || !capability.trim() || !method.trim()}
          >
            <Send size={15} aria-hidden="true" />
            Broadcast
          </button>
          {matchCount !== null && (
            <span className="match-count">{matchCount} runtime(s) responded</span>
          )}
        </div>

        {error && <div className="cp-error">{error}</div>}
      </div>

      {result && (
        <div className="broadcast-results">
          {result.results.map((entry) => {
            const failed = Boolean(entry.response?.error);
            return (
              <div className={`broadcast-card ${failed ? "error" : "success"}`} key={entry.runtime}>
                <div className="broadcast-card-head">
                  <strong>{entry.runtime}</strong>
                  <span className={`status-tag ${failed ? "error" : "success"}`}>
                    {failed ? "error" : "ok"}
                  </span>
                </div>
                <pre>{JSON.stringify(entry.response, null, 2)}</pre>
              </div>
            );
          })}
          {result.results.length === 0 && (
            <div className="empty-state large">
              No runtime advertises capability "{result.capability}"
            </div>
          )}
        </div>
      )}
    </section>
  );
}
