import {
  Activity,
  Cable,
  GitBranch,
  HeartPulse,
  Gauge,
  Database,
  Radio,
  RefreshCw,
  TerminalSquare
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { ExplorerView } from "./views/ExplorerView";
import { PlansView } from "./views/PlansView";
import { HealthView } from "./views/HealthView";
import { MetricsView } from "./views/MetricsView";
import { ResourcesView } from "./views/ResourcesView";
import { BroadcastView } from "./views/BroadcastView";

type TabId = "explorer" | "plans" | "health" | "metrics" | "resources" | "broadcast";

interface TabDef {
  id: TabId;
  label: string;
  icon: React.ReactNode;
}

const TABS: TabDef[] = [
  { id: "explorer", label: "Explorer", icon: <TerminalSquare size={16} aria-hidden="true" /> },
  { id: "plans", label: "Plan Runs", icon: <GitBranch size={16} aria-hidden="true" /> },
  { id: "health", label: "Health", icon: <HeartPulse size={16} aria-hidden="true" /> },
  { id: "metrics", label: "Metrics", icon: <Gauge size={16} aria-hidden="true" /> },
  { id: "resources", label: "Resources", icon: <Database size={16} aria-hidden="true" /> },
  { id: "broadcast", label: "Broadcast", icon: <Radio size={16} aria-hidden="true" /> }
];

const defaultApiBase =
  localStorage.getItem("uab.apiBase") ?? "http://127.0.0.1:8787";

export function App() {
  const [apiBase, setApiBase] = useState(defaultApiBase);
  const [status, setStatus] = useState<"online" | "offline" | "loading">("loading");
  const [tab, setTab] = useState<TabId>("explorer");
  const [refreshKey, setRefreshKey] = useState(0);

  const onStatus = useCallback((next: "online" | "offline" | "loading") => {
    setStatus(next);
  }, []);

  function saveApiBase(nextValue: string) {
    setApiBase(nextValue);
    localStorage.setItem("uab.apiBase", nextValue);
  }

  const view = useMemo(() => {
    switch (tab) {
      case "explorer":
        return <ExplorerView apiBase={apiBase} onStatus={onStatus} />;
      case "plans":
        return <PlansView apiBase={apiBase} refreshKey={refreshKey} />;
      case "health":
        return <HealthView apiBase={apiBase} refreshKey={refreshKey} />;
      case "metrics":
        return <MetricsView apiBase={apiBase} refreshKey={refreshKey} />;
      case "resources":
        return <ResourcesView apiBase={apiBase} refreshKey={refreshKey} />;
      case "broadcast":
        return <BroadcastView apiBase={apiBase} />;
      default:
        return null;
    }
  }, [tab, apiBase, onStatus, refreshKey]);

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <Cable size={22} aria-hidden="true" />
          </div>
          <div>
            <h1>Universal Agent Bridge</h1>
            <p>Control Plane Dashboard</p>
          </div>
        </div>
        <nav className="tabs">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              className={`tab ${entry.id === tab ? "active" : ""}`}
              onClick={() => setTab(entry.id)}
            >
              {entry.icon}
              <span>{entry.label}</span>
            </button>
          ))}
        </nav>
        <div className="endpoint">
          <span className={`status-dot ${status}`} title={status} />
          <input
            value={apiBase}
            aria-label="API endpoint"
            onChange={(event) => saveApiBase(event.target.value)}
          />
          <button
            className="icon-button"
            onClick={() => setRefreshKey((value) => value + 1)}
            title="Refresh current view"
          >
            <RefreshCw size={17} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="tab-body">{view}</div>

      <footer className="app-footer">
        <Activity size={13} aria-hidden="true" />
        <span>Bridge {status}</span>
        <span className="footer-sep">·</span>
        <span>{apiBase}</span>
      </footer>
    </main>
  );
}
