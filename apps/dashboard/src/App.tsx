import {
  Activity,
  Cable,
  Clock,
  Copy,
  Database,
  Gauge,
  Radio,
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

interface AgUiEvent {
  type: string;
  timestamp?: number;
  message?: string;
  code?: string;
  delta?: string;
  name?: string;
  value?: unknown;
  snapshot?: unknown;
  result?: unknown;
  [key: string]: unknown;
}

type A2uiEnvelopeType =
  | "createSurface"
  | "updateComponents"
  | "updateDataModel"
  | "deleteSurface"
  | "actionResponse"
  | "callFunction";

interface A2uiAction {
  type: "submit" | "callFunction" | "rpc" | "link";
  name?: string;
  label?: string;
  params?: Record<string, unknown>;
}

interface A2uiComponent {
  id?: string;
  type: string;
  title?: string;
  text?: string;
  label?: string;
  name?: string;
  value?: unknown;
  placeholder?: string;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  columns?: string[];
  rows?: Record<string, unknown>[];
  items?: unknown[];
  children?: A2uiComponent[];
  action?: A2uiAction;
  props?: Record<string, unknown>;
}

interface A2uiEnvelope {
  version: string;
  type: A2uiEnvelopeType;
  surfaceId: string;
  components?: A2uiComponent[];
  dataModel?: Record<string, unknown>;
  actions?: A2uiAction[];
  payload?: unknown;
  meta?: Record<string, unknown>;
}

interface A2uiSurface {
  id: string;
  envelope: A2uiEnvelope;
  components: A2uiComponent[];
  dataModel: Record<string, unknown>;
  updatedAt: string;
  lastEvent: A2uiEnvelopeType;
}

const A2UI_EVENT_NAME = "a2ui.envelope";
const A2UI_ENVELOPE_TYPES = new Set<string>([
  "createSurface",
  "updateComponents",
  "updateDataModel",
  "deleteSurface",
  "actionResponse",
  "callFunction"
]);
const A2UI_COMPONENT_TYPES = new Set<string>([
  "surface",
  "card",
  "heading",
  "text",
  "button",
  "input",
  "form",
  "list",
  "table",
  "stat",
  "row",
  "column",
  "divider"
]);

const defaultApiBase =
  localStorage.getItem("uab.apiBase") ?? "http://127.0.0.1:8787";

export function App() {
  const [apiBase, setApiBase] = useState(defaultApiBase);
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [selectedRuntime, setSelectedRuntime] = useState("");
  const [method, setMethod] = useState("");
  const [params, setParams] = useState("{}");
  const [response, setResponse] = useState<BridgeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<"online" | "offline" | "loading">("loading");
  const [filter, setFilter] = useState("");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [methods, setMethods] = useState<MethodDefinition[]>([]);
  const [agUiEvents, setAgUiEvents] = useState<AgUiEvent[]>([]);
  const [agUiText, setAgUiText] = useState("");
  const [a2uiSurfaces, setA2uiSurfaces] = useState<A2uiSurface[]>([]);
  const [streaming, setStreaming] = useState(false);

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
      } else if (data.runtimes.length === 0) {
        setSelectedRuntime("");
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
    if (!selectedRuntime) {
      setMethods([]);
      setMethod("");
      return;
    }

    try {
      const data = await requestJson<MethodsResponse>(
        `${apiBase}/methods?runtime=${encodeURIComponent(selectedRuntime)}`
      );
      const runtimeMethods = data.runtimes.find((entry) => entry.runtime === selectedRuntime);
      const nextMethods = runtimeMethods?.methods ?? [];
      setMethods(nextMethods);
      if (nextMethods.length > 0 && !nextMethods.some((entry) => entry.name === method)) {
        setMethod(nextMethods[0].name);
      } else if (nextMethods.length === 0) {
        setMethod("");
      }
    } catch (error) {
      setMethods([]);
      setMethod("");
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

  async function sendAgUiRun() {
    setStreaming(true);
    setAgUiEvents([]);
    setAgUiText("");
    setA2uiSurfaces([]);
    const runId = `run_${Date.now().toString(36)}`;

    try {
      const parsedParams = params.trim() ? JSON.parse(params) : {};
      const payload = {
        threadId: `thread_${selectedRuntime}`,
        runId,
        state: {
          runtime: selectedRuntime,
          method
        },
        messages: [],
        tools: [],
        context: [],
        forwardedProps: {
          uab: {
            runtime: selectedRuntime,
            method,
            params: parsedParams
          }
        }
      };

      await streamAgUiEvents(`${apiBase}/agui/runs`, payload, (event) => {
        setAgUiEvents((current) => [...current, event].slice(-40));
        if (event.type === "TEXT_MESSAGE_CONTENT" && typeof event.delta === "string") {
          setAgUiText((current) => `${current}${event.delta}`);
        }
        if (event.type === "CUSTOM" && event.name === A2UI_EVENT_NAME) {
          const envelope = readA2uiEnvelope(event.value);
          if (envelope) {
            applyA2uiEnvelope(envelope);
          }
        }
      });

      await refreshAudit();
      pushLog("success", "AG-UI stream completed", `${selectedRuntime}.${method}`);
    } catch (error) {
      pushLog("error", "AG-UI stream failed", errorToMessage(error));
    } finally {
      setStreaming(false);
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

  function applyA2uiEnvelope(envelope: A2uiEnvelope) {
    setA2uiSurfaces((current) => reduceA2uiSurfaces(current, envelope));
    pushLog("info", "A2UI surface updated", `${envelope.type}:${envelope.surfaceId}`);
  }

  function handleA2uiAction(surface: A2uiSurface, action?: A2uiAction) {
    if (!action) return;
    pushLog(
      "info",
      "A2UI action captured",
      `${surface.id}.${action.name ?? action.type}`
    );
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
                <button className="primary-button" onClick={sendRpc} disabled={loading || !selectedRuntime || !method}>
                  {loading ? <Zap size={17} aria-hidden="true" /> : <Play size={17} aria-hidden="true" />}
                  Send
                </button>
                <button className="secondary-button" onClick={sendAgUiRun} disabled={streaming || !selectedRuntime || !method}>
                  {streaming ? <Zap size={16} aria-hidden="true" /> : <Radio size={16} aria-hidden="true" />}
                  AG-UI
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

              <div className="event-panel">
                <div className="event-head">
                  <strong>AG-UI Events</strong>
                  <span>{agUiEvents.length}</span>
                </div>
                {agUiText && <pre className="agui-text">{agUiText}</pre>}
                <div className="event-list">
                  {agUiEvents.map((event, index) => (
                    <div className="event-row" key={`${event.type}_${index}`}>
                      <span>{event.type}</span>
                      <small>{formatAgUiEvent(event)}</small>
                    </div>
                  ))}
                  {agUiEvents.length === 0 && (
                    <div className="empty-state compact-empty">No stream events</div>
                  )}
                </div>
              </div>

              <div className="a2ui-panel">
                <div className="event-head">
                  <strong>Dynamic UI</strong>
                  <span>{a2uiSurfaces.length}</span>
                </div>
                <div className="a2ui-surface-list">
                  {a2uiSurfaces.map((surface) => (
                    <A2uiSurfaceView
                      key={surface.id}
                      surface={surface}
                      onAction={handleA2uiAction}
                    />
                  ))}
                  {a2uiSurfaces.length === 0 && (
                    <div className="empty-state compact-empty">No A2UI surface</div>
                  )}
                </div>
              </div>
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

function A2uiSurfaceView(props: {
  surface: A2uiSurface;
  onAction: (surface: A2uiSurface, action?: A2uiAction) => void;
}) {
  const { surface } = props;
  const title = readSurfaceTitle(surface);

  return (
    <section className="a2ui-surface">
      <div className="a2ui-surface-head">
        <div>
          <strong>{title}</strong>
          <small>{surface.id} / {surface.lastEvent}</small>
        </div>
        <Badge tone="write">{surface.envelope.version}</Badge>
      </div>
      <div className="a2ui-components">
        {surface.components.map((component, index) => (
          <A2uiComponentView
            key={component.id ?? `${component.type}_${index}`}
            component={component}
            surface={surface}
            onAction={props.onAction}
          />
        ))}
        {surface.components.length === 0 && (
          <pre className="a2ui-data">{JSON.stringify(surface.dataModel, null, 2)}</pre>
        )}
      </div>
    </section>
  );
}

function A2uiComponentView(props: {
  component: A2uiComponent;
  surface: A2uiSurface;
  onAction: (surface: A2uiSurface, action?: A2uiAction) => void;
}) {
  const { component, surface, onAction } = props;

  switch (component.type) {
    case "surface":
    case "card":
      return (
        <section className={`a2ui-component ${component.type}`}>
          {component.title && <strong className="a2ui-title">{component.title}</strong>}
          {component.text && <p className="a2ui-text">{component.text}</p>}
          {component.children && (
            <div className="a2ui-children">
              {component.children.map((child, index) => (
                <A2uiComponentView
                  key={child.id ?? `${child.type}_${index}`}
                  component={child}
                  surface={surface}
                  onAction={onAction}
                />
              ))}
            </div>
          )}
        </section>
      );
    case "heading":
      return <h3 className="a2ui-heading">{component.text ?? component.title ?? ""}</h3>;
    case "text":
      return <p className="a2ui-text">{component.text ?? stringifyA2uiValue(component.value ?? "")}</p>;
    case "stat":
      return (
        <div className="a2ui-stat">
          <small>{component.label ?? component.title ?? "Value"}</small>
          <strong>{stringifyA2uiValue(component.value ?? component.text ?? "")}</strong>
        </div>
      );
    case "list":
      return (
        <section className="a2ui-component">
          {component.title && <strong className="a2ui-title">{component.title}</strong>}
          <ul className="a2ui-list">
            {(component.items ?? []).map((item, index) => (
              <li key={index}>{stringifyA2uiValue(item)}</li>
            ))}
          </ul>
        </section>
      );
    case "table":
      return <A2uiTable component={component} />;
    case "input":
      return (
        <label className="a2ui-input">
          <span>{component.label ?? component.name ?? "Input"}</span>
          <input
            defaultValue={stringifyA2uiValue(component.value ?? "")}
            placeholder={component.placeholder}
          />
        </label>
      );
    case "button":
      return (
        <button
          className={`a2ui-button ${component.variant ?? "secondary"}`}
          onClick={() => onAction(surface, component.action)}
        >
          {component.label ?? component.text ?? component.action?.label ?? "Action"}
        </button>
      );
    case "form":
    case "row":
    case "column":
      return (
        <div className={`a2ui-group ${component.type}`}>
          {component.title && <strong className="a2ui-title">{component.title}</strong>}
          {(component.children ?? []).map((child, index) => (
            <A2uiComponentView
              key={child.id ?? `${child.type}_${index}`}
              component={child}
              surface={surface}
              onAction={onAction}
            />
          ))}
        </div>
      );
    case "divider":
      return <hr className="a2ui-divider" />;
    default:
      return null;
  }
}

function A2uiTable(props: { component: A2uiComponent }) {
  const columns = props.component.columns ?? [];
  const rows = props.component.rows ?? [];

  if (columns.length === 0 || rows.length === 0) {
    return null;
  }

  return (
    <div className="a2ui-table-wrap">
      {props.component.title && <strong className="a2ui-title">{props.component.title}</strong>}
      <table className="a2ui-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td key={column}>{stringifyA2uiValue(row[column])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function readA2uiEnvelope(value: unknown): A2uiEnvelope | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.version !== "string") return undefined;
  if (!isA2uiEnvelopeType(value.type)) return undefined;
  if (typeof value.surfaceId !== "string" || value.surfaceId.trim() === "") return undefined;

  return {
    version: value.version,
    type: value.type,
    surfaceId: value.surfaceId.trim(),
    components: readA2uiComponents(value.components),
    dataModel: isRecord(value.dataModel) ? value.dataModel : undefined,
    actions: readA2uiActions(value.actions),
    payload: value.payload,
    meta: isRecord(value.meta) ? value.meta : undefined
  };
}

function reduceA2uiSurfaces(current: A2uiSurface[], envelope: A2uiEnvelope): A2uiSurface[] {
  if (envelope.type === "deleteSurface") {
    return current.filter((surface) => surface.id !== envelope.surfaceId);
  }

  const now = new Date().toLocaleTimeString();
  const existing = current.find((surface) => surface.id === envelope.surfaceId);
  const dataModel = {
    ...(existing?.dataModel ?? {}),
    ...(envelope.dataModel ?? {})
  };
  const components = envelope.components ?? existing?.components ?? [];
  const nextSurface: A2uiSurface = {
    id: envelope.surfaceId,
    envelope: {
      ...envelope,
      components,
      dataModel
    },
    components,
    dataModel,
    updatedAt: now,
    lastEvent: envelope.type
  };

  if (!existing) return [nextSurface, ...current].slice(0, 8);

  return current.map((surface) => (
    surface.id === envelope.surfaceId ? nextSurface : surface
  ));
}

function readA2uiComponents(value: unknown): A2uiComponent[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((entry) => readA2uiComponent(entry))
    .filter((entry): entry is A2uiComponent => Boolean(entry));
}

function readA2uiComponent(value: unknown): A2uiComponent | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (!A2UI_COMPONENT_TYPES.has(value.type)) return undefined;

  return {
    id: readOptionalString(value.id),
    type: value.type,
    title: readOptionalString(value.title),
    text: readOptionalString(value.text),
    label: readOptionalString(value.label),
    name: readOptionalString(value.name),
    value: value.value,
    placeholder: readOptionalString(value.placeholder),
    variant: readA2uiVariant(value.variant),
    columns: Array.isArray(value.columns)
      ? value.columns.filter((entry): entry is string => typeof entry === "string")
      : undefined,
    rows: Array.isArray(value.rows) ? value.rows.filter(isRecord) : undefined,
    items: Array.isArray(value.items) ? value.items : undefined,
    children: readA2uiComponents(value.children),
    action: readA2uiAction(value.action),
    props: isRecord(value.props) ? value.props : undefined
  };
}

function readA2uiActions(value: unknown): A2uiAction[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((entry) => readA2uiAction(entry))
    .filter((entry): entry is A2uiAction => Boolean(entry));
}

function readA2uiAction(value: unknown): A2uiAction | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.type !== "submit" &&
    value.type !== "callFunction" &&
    value.type !== "rpc" &&
    value.type !== "link"
  ) {
    return undefined;
  }

  return {
    type: value.type,
    name: readOptionalString(value.name),
    label: readOptionalString(value.label),
    params: isRecord(value.params) ? value.params : undefined
  };
}

function readA2uiVariant(value: unknown): A2uiComponent["variant"] {
  if (
    value === "primary" ||
    value === "secondary" ||
    value === "danger" ||
    value === "ghost"
  ) {
    return value;
  }
  return undefined;
}

function readSurfaceTitle(surface: A2uiSurface): string {
  const firstTitled = surface.components.find((component) => component.title || component.text);
  return firstTitled?.title ?? firstTitled?.text ?? surface.id;
}

function stringifyA2uiValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function isA2uiEnvelopeType(value: unknown): value is A2uiEnvelopeType {
  return typeof value === "string" && A2UI_ENVELOPE_TYPES.has(value);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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

async function streamAgUiEvents(
  url: string,
  payload: unknown,
  onEvent: (event: AgUiEvent) => void
): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";

    for (const chunk of chunks) {
      const event = parseSseData(chunk);
      if (event) onEvent(event);
    }
  }

  if (buffer.trim()) {
    const event = parseSseData(buffer);
    if (event) onEvent(event);
  }
}

function parseSseData(chunk: string): AgUiEvent | undefined {
  const data = chunk
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return undefined;
  return JSON.parse(data) as AgUiEvent;
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
  return "{}";
}

function formatAgUiEvent(event: AgUiEvent): string {
  if (typeof event.delta === "string") return event.delta.slice(0, 120);
  if (typeof event.message === "string") return event.message;
  if (typeof event.name === "string") return event.name;
  return event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : "";
}
