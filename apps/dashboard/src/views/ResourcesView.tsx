import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Plus, Trash2, FileText, Brain } from "lucide-react";
import {
  requestJson,
  errorToMessage,
  formatTime,
  type BridgeResource,
  type ResourceListResponse
} from "../lib";

interface ResourcesViewProps {
  apiBase: string;
  refreshKey: number;
}

type KindFilter = "all" | "memory" | "artifact";

const NEW_RESOURCE = JSON.stringify(
  {
    kind: "memory",
    runtime: "dashboard",
    name: "note",
    data: { text: "Created from the dashboard" }
  },
  null,
  2
);

export function ResourcesView({ apiBase, refreshKey }: ResourcesViewProps) {
  const [resources, setResources] = useState<BridgeResource[]>([]);
  const [kind, setKind] = useState<KindFilter>("all");
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState(NEW_RESOURCE);
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const query = kind === "all" ? "" : `?kind=${kind}`;
      const data = await requestJson<ResourceListResponse>(`${apiBase}/resources${query}`);
      setResources(data.resources ?? []);
      setError(null);
    } catch (caught) {
      setError(errorToMessage(caught));
    }
  }, [apiBase, kind]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const selected = useMemo(
    () => resources.find((resource) => resource.id === selectedId) ?? null,
    [resources, selectedId]
  );

  async function createResource() {
    setBusy(true);
    setError(null);
    try {
      const body = JSON.parse(draft);
      const data = await requestJson<{ resource: BridgeResource }>(`${apiBase}/resources`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      if (data.resource) setSelectedId(data.resource.id);
      setShowCreate(false);
      await load();
    } catch (caught) {
      setError(errorToMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function deleteResource(id: string) {
    setBusy(true);
    try {
      await requestJson(`${apiBase}/resources/${encodeURIComponent(id)}`, {
        method: "DELETE"
      });
      if (selectedId === id) setSelectedId(null);
      await load();
    } catch (caught) {
      setError(errorToMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="cp-view resources-view">
      <div className="cp-column">
        <div className="cp-panel">
          <div className="cp-panel-head">
            <div>
              <h2>Resources</h2>
              <p>{resources.length} indexed memory / artifact record(s)</p>
            </div>
            <div className="head-actions">
              <button
                className="icon-button"
                onClick={() => setShowCreate((value) => !value)}
                title="Create resource"
              >
                <Plus size={16} aria-hidden="true" />
              </button>
              <button className="icon-button" onClick={() => void load()} title="Refresh">
                <RefreshCw size={15} aria-hidden="true" />
              </button>
            </div>
          </div>

          <div className="kind-tabs">
            {(["all", "memory", "artifact"] as KindFilter[]).map((option) => (
              <button
                key={option}
                className={`kind-tab ${kind === option ? "active" : ""}`}
                onClick={() => setKind(option)}
              >
                {option}
              </button>
            ))}
          </div>

          {showCreate && (
            <div className="create-box">
              <textarea
                className="plan-editor small"
                spellCheck={false}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
              <div className="cp-toolbar">
                <button className="primary-button" onClick={createResource} disabled={busy}>
                  <Plus size={15} aria-hidden="true" />
                  Create
                </button>
                <button className="secondary-button" onClick={() => setDraft(NEW_RESOURCE)} disabled={busy}>
                  Reset
                </button>
              </div>
            </div>
          )}

          {error && <div className="cp-error">{error}</div>}

          <div className="resource-list">
            {resources.map((resource) => (
              <button
                key={resource.id}
                className={`resource-row ${resource.id === selectedId ? "active" : ""}`}
                onClick={() => setSelectedId(resource.id)}
              >
                {resource.kind === "memory" ? (
                  <Brain size={16} aria-hidden="true" />
                ) : (
                  <FileText size={16} aria-hidden="true" />
                )}
                <span className="resource-row-body">
                  <strong>{resource.name ?? resource.id}</strong>
                  <small>
                    {resource.runtime} · {resource.sourceMethod}
                  </small>
                </span>
                <span className={`kind-tag ${resource.kind}`}>{resource.kind}</span>
              </button>
            ))}
            {resources.length === 0 && !error && (
              <div className="empty-state">No resources</div>
            )}
          </div>
        </div>
      </div>

      <div className="cp-column detail-column">
        <div className="cp-panel">
          {selected ? (
            <>
              <div className="cp-panel-head">
                <div>
                  <h2>{selected.name ?? selected.id}</h2>
                  <p>
                    {selected.kind} · {selected.runtime}
                  </p>
                </div>
                <button
                  className="danger-button"
                  onClick={() => deleteResource(selected.id)}
                  disabled={busy}
                >
                  <Trash2 size={15} aria-hidden="true" />
                  Delete
                </button>
              </div>
              <div className="run-detail-meta">
                <MetaItem label="Source" value={selected.sourceMethod} />
                <MetaItem label="Trace" value={selected.traceId} />
                <MetaItem label="Session" value={selected.sessionId ?? "-"} />
                <MetaItem label="Updated" value={formatTime(selected.updatedAt)} />
              </div>
              <pre className="resource-data">{JSON.stringify(selected, null, 2)}</pre>
            </>
          ) : (
            <div className="empty-state large">Select a resource to inspect it.</div>
          )}
        </div>
      </div>
    </section>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="meta-item">
      <small>{label}</small>
      <strong className="truncate">{value}</strong>
    </div>
  );
}
