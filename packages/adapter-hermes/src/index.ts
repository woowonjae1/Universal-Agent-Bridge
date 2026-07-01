import {
  AdapterError,
  type AdapterHealth,
  type AgentRuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeMethodDefinition
} from "@uab/adapter-sdk";
import {
  BRIDGE_ERROR_CODES,
  isJsonObject,
  type JsonObject,
  type JsonValue
} from "@uab/protocol";

export interface HermesAdapterOptions {
  id?: string;
  name?: string;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  model?: string;
}

const DEFAULT_METHODS: RuntimeMethodDefinition[] = [
  {
    name: "system.health",
    title: "Health",
    description: "Read Hermes API Server health.",
    capability: "system",
    risk: "read",
    paramsExample: { detailed: false }
  },
  {
    name: "runtime.capabilities",
    title: "Capabilities",
    description: "Read Hermes API Server capability discovery.",
    capability: "runtime",
    risk: "read",
    paramsExample: {}
  },
  {
    name: "models.list",
    title: "Models",
    description: "List OpenAI-compatible models advertised by Hermes.",
    capability: "models",
    risk: "read",
    paramsExample: {}
  },
  {
    name: "chat.completions.create",
    title: "Chat Completion",
    description: "Create an OpenAI-compatible chat completion through Hermes.",
    capability: "chat",
    risk: "write",
    paramsExample: {
      model: "hermes-agent",
      messages: [{ role: "user", content: "Hello" }],
      stream: false
    }
  },
  {
    name: "responses.create",
    title: "Response",
    description: "Create an OpenAI Responses API response through Hermes.",
    capability: "responses",
    risk: "write",
    paramsExample: { input: "Summarize this project", store: true }
  },
  {
    name: "responses.get",
    title: "Get Response",
    description: "Fetch a stored Hermes response by id.",
    capability: "responses",
    risk: "read",
    paramsExample: { id: "resp_abc123" }
  },
  {
    name: "responses.delete",
    title: "Delete Response",
    description: "Delete a stored Hermes response by id.",
    capability: "responses",
    risk: "write",
    paramsExample: { id: "resp_abc123" }
  },
  {
    name: "runs.create",
    title: "Create Run",
    description: "Start a long-form Hermes run.",
    capability: "runs",
    risk: "write",
    paramsExample: { input: "Run the test suite", session_id: "project-main" }
  },
  {
    name: "runs.get",
    title: "Get Run",
    description: "Poll a Hermes run state.",
    capability: "runs",
    risk: "read",
    paramsExample: { run_id: "run_abc123" }
  },
  {
    name: "runs.stop",
    title: "Stop Run",
    description: "Ask Hermes to stop a running agent turn.",
    capability: "runs",
    risk: "write",
    paramsExample: { run_id: "run_abc123" }
  },
  {
    name: "runs.approval",
    title: "Resolve Approval",
    description: "Resolve a pending Hermes run approval.",
    capability: "approvals",
    risk: "write",
    paramsExample: { run_id: "run_abc123", decision: "approve" }
  },
  {
    name: "sessions.list",
    title: "Sessions",
    description: "List Hermes sessions.",
    capability: "sessions",
    risk: "read",
    paramsExample: { limit: 50, offset: 0 }
  },
  {
    name: "sessions.create",
    title: "Create Session",
    description: "Create an empty Hermes session.",
    capability: "sessions",
    risk: "write",
    paramsExample: { title: "Project session" }
  },
  {
    name: "sessions.get",
    title: "Get Session",
    description: "Read Hermes session metadata.",
    capability: "sessions",
    risk: "read",
    paramsExample: { id: "session_id" }
  },
  {
    name: "sessions.update",
    title: "Update Session",
    description: "Patch Hermes session metadata.",
    capability: "sessions",
    risk: "write",
    paramsExample: { id: "session_id", title: "New title" }
  },
  {
    name: "sessions.delete",
    title: "Delete Session",
    description: "Delete a Hermes session.",
    capability: "sessions",
    risk: "write",
    paramsExample: { id: "session_id" }
  },
  {
    name: "sessions.messages",
    title: "Session Messages",
    description: "Read Hermes session message history.",
    capability: "sessions",
    risk: "read",
    paramsExample: { id: "session_id" }
  },
  {
    name: "sessions.fork",
    title: "Fork Session",
    description: "Fork a Hermes session lineage.",
    capability: "sessions",
    risk: "write",
    paramsExample: { id: "session_id", title: "Alternative path" }
  },
  {
    name: "sessions.chat",
    title: "Session Chat",
    description: "Run one synchronous Hermes agent turn in a session.",
    capability: "sessions",
    risk: "write",
    paramsExample: { id: "session_id", input: "What changed?" }
  },
  {
    name: "skills.listInstalled",
    title: "Skills",
    description: "List Hermes skills.",
    capability: "skills",
    risk: "read",
    paramsExample: {}
  },
  {
    name: "toolsets.list",
    title: "Toolsets",
    description: "List Hermes toolsets.",
    capability: "tools",
    risk: "read",
    paramsExample: {}
  },
  {
    name: "jobs.list",
    title: "Jobs",
    description: "List Hermes scheduled jobs.",
    capability: "jobs",
    risk: "read",
    paramsExample: {}
  },
  {
    name: "jobs.create",
    title: "Create Job",
    description: "Create a Hermes scheduled job.",
    capability: "jobs",
    risk: "write",
    paramsExample: { prompt: "Daily project summary", schedule: "0 9 * * *" }
  },
  {
    name: "jobs.get",
    title: "Get Job",
    description: "Read one Hermes scheduled job.",
    capability: "jobs",
    risk: "read",
    paramsExample: { job_id: "job_abc123" }
  },
  {
    name: "jobs.update",
    title: "Update Job",
    description: "Patch a Hermes scheduled job.",
    capability: "jobs",
    risk: "write",
    paramsExample: { job_id: "job_abc123", schedule: "0 10 * * *" }
  },
  {
    name: "jobs.delete",
    title: "Delete Job",
    description: "Delete a Hermes scheduled job.",
    capability: "jobs",
    risk: "write",
    paramsExample: { job_id: "job_abc123" }
  },
  {
    name: "jobs.pause",
    title: "Pause Job",
    description: "Pause a Hermes scheduled job.",
    capability: "jobs",
    risk: "write",
    paramsExample: { job_id: "job_abc123" }
  },
  {
    name: "jobs.resume",
    title: "Resume Job",
    description: "Resume a Hermes scheduled job.",
    capability: "jobs",
    risk: "write",
    paramsExample: { job_id: "job_abc123" }
  },
  {
    name: "jobs.run",
    title: "Run Job",
    description: "Trigger a Hermes scheduled job immediately.",
    capability: "jobs",
    risk: "write",
    paramsExample: { job_id: "job_abc123" }
  }
];

const CAPABILITIES: RuntimeCapabilities = {
  system: { read: true, methods: ["system.health"] },
  runtime: { read: true, methods: ["runtime.capabilities"] },
  models: { read: true, methods: ["models.list"] },
  chat: { write: true, methods: ["chat.completions.create"] },
  responses: {
    read: true,
    write: true,
    methods: ["responses.create", "responses.get", "responses.delete"]
  },
  runs: {
    read: true,
    write: true,
    methods: ["runs.create", "runs.get", "runs.stop", "runs.approval"]
  },
  sessions: {
    read: true,
    write: true,
    methods: [
      "sessions.list",
      "sessions.create",
      "sessions.get",
      "sessions.update",
      "sessions.delete",
      "sessions.messages",
      "sessions.fork",
      "sessions.chat"
    ]
  },
  skills: { read: true, methods: ["skills.listInstalled"] },
  tools: { read: true, methods: ["toolsets.list"] },
  jobs: {
    read: true,
    write: true,
    methods: [
      "jobs.list",
      "jobs.create",
      "jobs.get",
      "jobs.update",
      "jobs.delete",
      "jobs.pause",
      "jobs.resume",
      "jobs.run"
    ]
  }
};

export function createHermesAdapter(
  options: HermesAdapterOptions = {}
): AgentRuntimeAdapter {
  const baseUrl = (options.baseUrl ?? "http://127.0.0.1:8642").replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 30_000;
  const token = options.token;
  const defaultModel = options.model ?? "hermes-agent";

  const client = {
    get(path: string) {
      return requestJson(baseUrl, path, { method: "GET" }, token, timeoutMs);
    },
    post(path: string, body?: unknown, headers?: Record<string, string>) {
      return requestJson(baseUrl, path, {
        method: "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      }, token, timeoutMs);
    },
    patch(path: string, body?: unknown) {
      return requestJson(baseUrl, path, {
        method: "PATCH",
        body: body === undefined ? undefined : JSON.stringify(body)
      }, token, timeoutMs);
    },
    delete(path: string) {
      return requestJson(baseUrl, path, { method: "DELETE" }, token, timeoutMs);
    }
  };

  return {
    info: {
      id: options.id ?? "hermes",
      name: options.name ?? "Hermes Agent",
      description: `Hermes API Server adapter for ${baseUrl}`
    },
    capabilities() {
      return CAPABILITIES;
    },
    methods() {
      return DEFAULT_METHODS;
    },
    async health(): Promise<AdapterHealth> {
      try {
        const health = await client.get("/health");
        return {
          status: readStatus(health),
          details: toJsonValue(health)
        };
      } catch (error) {
        return {
          status: "down",
          details: {
            error: error instanceof Error ? error.message : String(error)
          }
        };
      }
    },
    async call(request) {
      switch (request.method) {
        case "system.health": {
          const detailed = readBooleanParam(request.params, "detailed", false);
          return client.get(detailed ? "/health/detailed" : "/health");
        }
        case "runtime.capabilities":
          return client.get("/v1/capabilities");
        case "models.list":
          return client.get("/v1/models");
        case "chat.completions.create": {
          const body = withDefaultModel(readObjectParams(request.params), defaultModel);
          return client.post(
            "/v1/chat/completions",
            withoutKeys(body, ["session_id", "session_key"]),
            hermesSessionHeaders(request.params)
          );
        }
        case "responses.create": {
          const body = withDefaultModel(readObjectParams(request.params), defaultModel);
          return client.post(
            "/v1/responses",
            withoutKeys(body, ["session_id", "session_key"]),
            hermesSessionHeaders(request.params)
          );
        }
        case "responses.get":
          return client.get(`/v1/responses/${encodeURIComponent(readId(request.params))}`);
        case "responses.delete":
          return client.delete(`/v1/responses/${encodeURIComponent(readId(request.params))}`);
        case "runs.create": {
          const body = readObjectParams(request.params);
          return client.post(
            "/v1/runs",
            withoutKeys(body, ["session_key"]),
            hermesSessionHeaders(request.params)
          );
        }
        case "runs.get":
          return client.get(`/v1/runs/${encodeURIComponent(readStringParam(request.params, "run_id"))}`);
        case "runs.stop":
          return client.post(`/v1/runs/${encodeURIComponent(readStringParam(request.params, "run_id"))}/stop`, {});
        case "runs.approval": {
          const params = readObjectParams(request.params);
          const runId = readStringParam(params, "run_id");
          return client.post(`/v1/runs/${encodeURIComponent(runId)}/approval`, withoutKeys(params, ["run_id"]));
        }
        case "sessions.list": {
          const query = buildQuery(readObjectParams(request.params, true), [
            "limit",
            "offset",
            "source",
            "include_children"
          ]);
          return client.get(`/api/sessions${query}`);
        }
        case "sessions.create":
          return client.post("/api/sessions", readObjectParams(request.params, true));
        case "sessions.get":
          return client.get(`/api/sessions/${encodeURIComponent(readId(request.params))}`);
        case "sessions.update": {
          const params = readObjectParams(request.params);
          const id = readId(params);
          return client.patch(`/api/sessions/${encodeURIComponent(id)}`, withoutKeys(params, ["id", "session_id"]));
        }
        case "sessions.delete":
          return client.delete(`/api/sessions/${encodeURIComponent(readId(request.params))}`);
        case "sessions.messages":
          return client.get(`/api/sessions/${encodeURIComponent(readId(request.params))}/messages`);
        case "sessions.fork": {
          const params = readObjectParams(request.params);
          const id = readId(params);
          return client.post(`/api/sessions/${encodeURIComponent(id)}/fork`, withoutKeys(params, ["id", "session_id"]));
        }
        case "sessions.chat": {
          const params = readObjectParams(request.params);
          const id = readId(params);
          return client.post(`/api/sessions/${encodeURIComponent(id)}/chat`, withoutKeys(params, ["id", "session_id"]));
        }
        case "skills.listInstalled":
          return client.get("/v1/skills");
        case "toolsets.list":
          return client.get("/v1/toolsets");
        case "jobs.list":
          return client.get("/api/jobs");
        case "jobs.create":
          return client.post("/api/jobs", readObjectParams(request.params));
        case "jobs.get":
          return client.get(`/api/jobs/${encodeURIComponent(readStringParam(request.params, "job_id"))}`);
        case "jobs.update": {
          const params = readObjectParams(request.params);
          const jobId = readStringParam(params, "job_id");
          return client.patch(`/api/jobs/${encodeURIComponent(jobId)}`, withoutKeys(params, ["job_id"]));
        }
        case "jobs.delete":
          return client.delete(`/api/jobs/${encodeURIComponent(readStringParam(request.params, "job_id"))}`);
        case "jobs.pause":
          return client.post(`/api/jobs/${encodeURIComponent(readStringParam(request.params, "job_id"))}/pause`, {});
        case "jobs.resume":
          return client.post(`/api/jobs/${encodeURIComponent(readStringParam(request.params, "job_id"))}/resume`, {});
        case "jobs.run":
          return client.post(`/api/jobs/${encodeURIComponent(readStringParam(request.params, "job_id"))}/run`, {});
        default:
          throw new AdapterError(`Method '${request.method}' is not supported by Hermes adapter.`, {
            code: BRIDGE_ERROR_CODES.methodNotFound,
            data: { method: request.method }
          });
      }
    }
  };
}

async function requestJson(
  baseUrl: string,
  path: string,
  init: RequestInit,
  token: string | undefined,
  timeoutMs: number
): Promise<JsonValue> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers
      },
      signal: controller.signal
    });
    const data = await readJsonOrNull(response);

    if (!response.ok) {
      throw new AdapterError(`Hermes API returned HTTP ${response.status}.`, {
        code: BRIDGE_ERROR_CODES.adapterUnavailable,
        data
      });
    }

    return data;
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new AdapterError(`Hermes API request failed: ${message}`, {
      code: message.includes("abort") ? BRIDGE_ERROR_CODES.timeout : BRIDGE_ERROR_CODES.adapterUnavailable
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonOrNull(response: Response): Promise<JsonValue> {
  const text = await response.text();
  if (!text.trim()) return null;
  return JSON.parse(text) as JsonValue;
}

function readStatus(value: JsonValue): AdapterHealth["status"] {
  if (isJsonObject(value) && value.status === "ok") return "ok";
  if (isJsonObject(value) && value.status === "degraded") return "degraded";
  if (isJsonObject(value) && value.status === "down") return "down";
  return "degraded";
}

function readObjectParams(params: unknown, optional = false): JsonObject {
  if (params === undefined || params === null) {
    if (optional) return {};
    throw new AdapterError("Object params are required.", {
      code: BRIDGE_ERROR_CODES.invalidParams
    });
  }
  if (!isJsonObject(params)) {
    throw new AdapterError("Object params are required.", {
      code: BRIDGE_ERROR_CODES.invalidParams
    });
  }
  return params as JsonObject;
}

function readStringParam(params: unknown, key: string): string {
  const object = readObjectParams(params);
  const value = object[key];
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }
  throw new AdapterError(`Parameter '${key}' is required.`, {
    code: BRIDGE_ERROR_CODES.invalidParams
  });
}

function readBooleanParam(params: unknown, key: string, fallback: boolean): boolean {
  if (!isJsonObject(params)) return fallback;
  const value = params[key];
  return typeof value === "boolean" ? value : fallback;
}

function readId(params: unknown): string {
  const object = readObjectParams(params);
  const value = object.id ?? object.session_id ?? object.response_id;
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }
  throw new AdapterError("Parameter 'id' is required.", {
    code: BRIDGE_ERROR_CODES.invalidParams
  });
}

function withDefaultModel(params: JsonObject, model: string): JsonObject {
  if (typeof params.model === "string" && params.model.trim() !== "") {
    return params;
  }
  return {
    model,
    ...params
  };
}

function withoutKeys(params: JsonObject, keys: string[]): JsonObject {
  return Object.fromEntries(
    Object.entries(params).filter(([key]) => !keys.includes(key))
  ) as JsonObject;
}

function buildQuery(params: JsonObject, keys: string[]): string {
  const query = new URLSearchParams();
  for (const key of keys) {
    const value = params[key];
    if (value === undefined || value === null) continue;
    query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

function hermesSessionHeaders(params: unknown): Record<string, string> {
  if (!isJsonObject(params)) return {};
  const headers: Record<string, string> = {};
  if (typeof params.session_id === "string") {
    headers["X-Hermes-Session-Id"] = params.session_id;
  }
  if (typeof params.session_key === "string") {
    headers["X-Hermes-Session-Key"] = params.session_key;
  }
  return headers;
}

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
