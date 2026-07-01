import {
  Activity,
  Cable,
  Clock,
  Copy,
  Database,
  Gauge,
  Layers,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  ServerCog,
  ShieldCheck,
  SlidersHorizontal,
  TerminalSquare,
  Zap
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type CapabilityValue =
  | boolean
  | "read"
  | "write"
  | "admin"
  | {
      read?: boolean;
      write?: boolean;
      admin?: boolean;
      methods?: string[];
      description?: string;
    };

interface RuntimeInfo {
  id: string;
  name: string;
  version?: string;
  description?: string;
  capabilities: Record<string, CapabilityValue>;
  methodCount?: number;
}

interface RuntimeResponse {
  runtimes: RuntimeInfo[];
}

interface BridgeResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface LogEntry {
  id: string;
  kind: "info" | "success" | "error";
  label: string;
  detail: string;
  at: string;
}

interface AuditEntry {
  id: string;
  requestId: string | number | null;
  traceId: string;
  runtime: string;
  method: string;
  status: "success" | "error";
  code?: number;
  message?: string;
  durationMs: number;
  principalId?: string;
  source?: string;
  timestamp: string;
}

interface AuditResponse {
  entries: AuditEntry[];
  limit: number;
}

interface MethodDefinition {
  name: string;
  title?: string;
  description?: string;
  capability?: string;
  risk?: "read" | "write" | "admin";
  paramsExample?: unknown;
}

interface MethodsResponse {
  runtimes: Array<{
    runtime: string;
    methods: MethodDefinition[];
  }>;
}

const defaultApiBase =
  localStorage.getItem("uab.apiBase") ?? "http://127.0.0.1:8787";

const sampleParams: Record<string, string> = {
  "system.ping": JSON.stringify({ message: "hello" }, null, 2),
  "sessions.get": JSON.stringify({ id: "session_demo" }, null, 2),
  "sessions.create": JSON.stringify({ title: "New session" }, null, 2),
  "models.set": JSON.stringify({ model: "mock-balanced" }, null, 2)
};

export function App() {
  const [apiBase, setApiBase] = useState(defaultApiBase);
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [selectedRuntime, setSelectedRuntime] = useState("mock");
  const [method, setMethod] = useState("sessions.list");
  const [params, setParams] = useState("{}");
  const [response, setResponse] = useState<BridgeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<"online" | "offline" | "loading">("loading");
  const [filter, setFilter] = useState("");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [methods, setMethods] = useState<MethodDefinition[]>([]);

  const selected = useMemo(
    () => runtimes.find((runtime) => runtime.id === selectedRuntime),
    [runtimes, selectedRuntime]
  );

  const filteredRuntimes = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return runtimes;
    return runtimes.filter((runtime) =>
      `${runtime.id} ${runtime.name}`.toLowerCase().includes(needle)
    );
  }, [filter, runtimes]);

  useEffect(() => {
    void refreshAll();
  }, []);

  useEffect(() => {
    const definition = methods.find((entry) => entry.name === method);
    setParams(formatParamsExample(definition?.paramsExample, method));
  }, [method]);

  useEffect(() => {
    void refreshMethods();
  }, [selectedRuntime]);

  async function refreshAll() {
    await Promise.all([refreshRuntimes(), refreshAudit(), refreshMethods()]);
  }

  async function refreshRuntimes() {
    setStatus("loading");
    try {
      const data = await requestJson<RuntimeResponse>(`${apiBase}/runtimes`);
      setRuntimes(data.runtimes);
      if (data.runtimes.length > 0 && !data.runtimes.some((item) => item.id === selectedRuntime)) {
        setSelectedRuntime(data.runtimes[0].id);
      }
      setStatus("online");
      pushLog("success", "Runtimes refreshed", `${data.runtimes.length} runtime(s) available`);
    } catch (error) {
      setStatus("offline");
      pushLog("error", "Bridge unavailable", errorToMessage(error));
    }
  }

  async function refreshAudit() {
    try {
      const data = await requestJson<AuditResponse>(`${apiBase}/audit?limit=30`);
      setAuditEntries(data.entries);
    } catch (error) {
      pushLog("error", "Audit unavailable", errorToMessage(error));
    }
  }

  async function refreshMethods() {
    try {
      const data = await requestJson<MethodsResponse>(
        `${apiBase}/methods?runtime=${encodeURIComponent(selectedRuntime)}`
      );
      const runtimeMethods = data.runtimes.find((entry) => entry.runtime === selectedRuntime);
      const nextMethods = runtimeMethods?.methods ?? [];
      setMethods(nextMethods);
      if (nextMethods.length > 0 && !nextMethods.some((entry) => entry.name === method)) {
        setMethod(nextMethods[0].name);
      }
    } catch (error) {
      pushLog("error", "Methods unavailable", errorToMessage(error));
    }
  }

  async function sendRpc() {
    setLoading(true);
    setResponse(null);
    const requestId = `ui_${Date.now().toString(36)}`;

    try {
      const parsedParams = params.trim() ? JSON.parse(params) : {};
      const payload = {
        jsonrpc: "2.0",
        id: requestId,
        runtime: selectedRuntime,
        method,
        params: parsedParams,
        meta: {
          source: "dashboard",
          traceId: `trace_${requestId}`
        }
      };

      const result = await requestJson<BridgeResponse>(`${apiBase}/rpc`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      setResponse(result);
      await refreshAudit();
      pushLog(
        result.error ? "error" : "success",
        `${selectedRuntime}.${method}`,
        result.error ? result.error.message : "Request completed"
      );
    } catch (error) {
      const message = errorToMessage(error);
      const result: BridgeResponse = {
        jsonrpc: "2.0",
        id: requestId,
        error: {
          code: -32600,
          message
        }
      };
      setResponse(result);
      pushLog("error", `${selectedRuntime}.${method}`, message);
    } finally {
      setLoading(false);
    }
  }

  function resetParams() {
    const definition = methods.find((entry) => entry.name === method);
    setParams(formatParamsExample(definition?.paramsExample, method));
  }

  function selectMethod(definition: MethodDefinition) {
    setMethod(definition.name);
    setParams(formatParamsExample(definition.paramsExample, definition.name));
  }

  async function copyResponse() {
    if (!response) return;
    await navigator.clipboard.writeText(JSON.stringify(response, null, 2));
    pushLog("info", "Response copied", `${response.id ?? "notification"}`);
  }

  function saveApiBase(nextValue: string) {
    setApiBase(nextValue);
    localStorage.setItem("uab.apiBase", nextValue);
  }

  function pushLog(kind: LogEntry["kind"], label: string, detail: string) {
    setLogs((current) => [
      {
        id: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`,
        kind,
        label,
        detail,
        at: new Date().toLocaleTimeString()
      },
      ...current
    ].slice(0, 18));
  }

  const capabilityEntries = selected
    ? Object.entries(selected.capabilities)
    : [];

  const totalCapabilities = capabilityEntries.length;

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <Cable size={22} aria-hidden="true" />
          </div>
          <div>
            <h1>Universal Agent Bridge</h1>
            <p>Runtime Control Plane</p>
          </div>
        </div>
        <div className="endpoint">
          <span className={`status-dot ${status}`} />
          <input
            value={apiBase}
            aria-label="API endpoint"
            onChange={(event) => saveApiBase(event.target.value)}
          />
          <button className="icon-button" onClick={refreshAll} title="Refresh bridge state">
            <RefreshCw size={17} aria-hidden="true" />
          </button>
        </div>
      </header>

      <section className="layout">
        <aside className="sidebar">
          <div className="sidebar-head">
            <h2>Runtimes</h2>
            <span>{runtimes.length}</span>
          </div>
          <label className="search">
            <Search size={16} aria-hidden="true" />
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter"
            />
          </label>
          <div className="runtime-list">
            {filteredRuntimes.map((runtime) => (
              <button
                key={runtime.id}
                className={`runtime-row ${runtime.id === selectedRuntime ? "active" : ""}`}
                onClick={() => setSelectedRuntime(runtime.id)}
              >
                <ServerCog size={18} aria-hidden="true" />
                <span>
                  <strong>{runtime.name}</strong>
                  <small>{runtime.id}</small>
                </span>
              </button>
            ))}
            {filteredRuntimes.length === 0 && (
              <div className="empty-state">No runtime</div>
            )}
          </div>
        </aside>

        <section className="content">
          <div className="summary-grid">
            <Metric icon={<Activity size={18} />} label="Status" value={status} tone={status} />
            <Metric icon={<Layers size={18} />} label="Runtimes" value={String(runtimes.length)} />
            <Metric icon={<Gauge size={18} />} label="Capabilities" value={String(totalCapabilities)} />
            <Metric icon={<SlidersHorizontal size={18} />} label="Methods" value={String(methods.length)} />
          </div>

          <div className="workspace">
            <section className="panel runtime-panel">
              <div className="panel-title">
                <div>
                  <h2>{selected?.name ?? "Runtime"}</h2>
                  <p>{selected?.version ?? "0.1.0"}</p>
                </div>
                <span className="runtime-pill">{selected?.id ?? "none"}</span>
              </div>
              <div className="capability-grid">
                {capabilityEntries.map(([name, value]) => (
                  <div className="capability" key={name}>
                    <div className="capability-name">
                      <Database size={16} aria-hidden="true" />
                      <strong>{name}</strong>
                    </div>
                    <div className="mode-list">{renderCapabilityModes(value)}</div>
                  </div>
                ))}
              </div>
              <div className="method-catalog">
                <div className="panel-title catalog-title">
                  <div>
                    <h2>Method Catalog</h2>
                    <p>{methods.length} callable method(s)</p>
                  </div>
                  <ShieldCheck size={18} aria-hidden="true" />
                </div>
                <div className="method-list">
                  {methods.map((definition) => (
                    <button
                      className={`method-row ${definition.name === method ? "active" : ""}`}
                      key={definition.name}
                      onClick={() => selectMethod(definition)}
                    >
                      <span className={`risk-dot ${definition.risk ?? "read"}`} />
                      <span>
                        <strong>{definition.name}</strong>
                        <small>{definition.description ?? definition.title ?? "Runtime method"}</small>
                      </span>
                    </button>
                  ))}
                  {methods.length === 0 && <div className="empty-state">No methods</div>}
                </div>
              </div>
            </section>

            <section className="panel rpc-panel">
              <div className="panel-title compact">
                <div>
                  <h2>RPC Console</h2>
                  <p>{selectedRuntime}</p>
                </div>
                <TerminalSquare size={19} aria-hidden="true" />
              </div>

              <div className="form-grid">
                <label>
                  <span>Runtime</span>
                  <select
                    value={selectedRuntime}
                    onChange={(event) => setSelectedRuntime(event.target.value)}
                  >
                    {runtimes.map((runtime) => (
                      <option value={runtime.id} key={runtime.id}>
                        {runtime.id}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Method</span>
                  <select value={method} onChange={(event) => setMethod(event.target.value)}>
                    {methods.map((option) => (
                      <option value={option.name} key={option.name}>
                        {option.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="json-field">
                <span>Params</span>
                <textarea
                  spellCheck={false}
                  value={params}
                  onChange={(event) => setParams(event.target.value)}
                />
              </label>

              <div className="toolbar">
                <button className="primary-button" onClick={sendRpc} disabled={loading || !selectedRuntime}>
                  {loading ? <Zap size={17} aria-hidden="true" /> : <Play size={17} aria-hidden="true" />}
                  Send
                </button>
                <button className="secondary-button" onClick={resetParams}>
                  <RotateCcw size={16} aria-hidden="true" />
                  Reset
                </button>
                <button className="secondary-button" onClick={copyResponse} disabled={!response}>
                  <Copy size={16} aria-hidden="true" />
                  Copy
                </button>
              </div>

              <pre className="response-view">
                {response ? JSON.stringify(response, null, 2) : "{\n  \"jsonrpc\": \"2.0\"\n}"}
              </pre>
            </section>
          </div>
        </section>

        <aside className="log-panel">
          <div className="sidebar-head">
            <h2>Audit</h2>
            <Clock size={16} aria-hidden="true" />
          </div>
          <div className="audit-summary">
            <span>{auditEntries.length}</span>
            <strong>bridge calls</strong>
          </div>
          <div className="logs">
            {auditEntries.map((entry) => (
              <div className={`log-entry ${entry.status}`} key={entry.id}>
                <span>{formatAuditTime(entry.timestamp)} · {entry.durationMs}ms</span>
                <strong>{entry.runtime}.{entry.method}</strong>
                <p>{entry.message ?? entry.traceId}</p>
              </div>
            ))}
            {logs.map((entry) => (
              <div className={`log-entry ${entry.kind}`} key={entry.id}>
                <span>{entry.at}</span>
                <strong>{entry.label}</strong>
                <p>{entry.detail}</p>
              </div>
            ))}
            {logs.length === 0 && auditEntries.length === 0 && (
              <div className="empty-state">No activity</div>
            )}
          </div>
        </aside>
      </section>
    </main>
  );
}

function Metric(props: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className={`metric ${props.tone ?? ""}`}>
      <span>{props.icon}</span>
      <div>
        <small>{props.label}</small>
        <strong>{props.value}</strong>
      </div>
    </div>
  );
}

function renderCapabilityModes(value: CapabilityValue) {
  if (typeof value === "boolean") {
    return <Badge tone={value ? "read" : "off"}>{value ? "enabled" : "off"}</Badge>;
  }

  if (typeof value === "string") {
    return <Badge tone={value}>{value}</Badge>;
  }

  const modes = [
    value.read ? "read" : null,
    value.write ? "write" : null,
    value.admin ? "admin" : null
  ].filter(Boolean) as string[];

  if (modes.length === 0) return <Badge tone="off">off</Badge>;

  return modes.map((mode) => (
    <Badge key={mode} tone={mode}>
      {mode}
    </Badge>
  ));
}

function Badge(props: { tone: string; children: React.ReactNode }) {
  return <span className={`badge ${props.tone}`}>{props.children}</span>;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = (await response.json()) as T;
  if (!response.ok) {
    const message =
      typeof data === "object" &&
      data &&
      "error" in data &&
      typeof (data as { error?: { message?: unknown } }).error?.message === "string"
        ? (data as { error: { message: string } }).error.message
        : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return data;
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatAuditTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString();
}

function formatParamsExample(value: unknown, method: string): string {
  if (value !== undefined) {
    return JSON.stringify(value, null, 2);
  }
  return sampleParams[method] ?? "{}";
}
