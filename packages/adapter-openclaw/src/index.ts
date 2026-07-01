import { spawn } from "node:child_process";
import {
  AdapterError,
  type AdapterCallRequest,
  type AdapterStreamEvent,
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

export interface OpenClawAdapterOptions {
  id?: string;
  name?: string;
  gatewayUrl?: string;
  token?: string;
  password?: string;
  scopes?: string[];
  timeoutMs?: number;
  mode?: "gateway" | "cli";
  cliCommand?: string;
}

type GatewayFrame =
  | { type: "req"; id: string; method: string; params?: unknown }
  | { type: "res"; id: string; ok: boolean; payload?: unknown; error?: unknown }
  | { type: "event"; event: string; payload?: unknown; seq?: number; stateVersion?: number };

interface OpenClawGatewayEvent {
  event: string;
  payload?: JsonValue;
  seq?: number;
  stateVersion?: number;
}

interface WebSocketLike {
  addEventListener(type: "open", listener: () => void, options?: { once?: boolean }): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  addEventListener(type: "close", listener: () => void): void;
  send(data: string): void;
  close(): void;
}

interface WebSocketConstructor {
  new(url: string): WebSocketLike;
}

const DEFAULT_METHODS: RuntimeMethodDefinition[] = [
  {
    name: "health",
    title: "Health",
    description: "Read OpenClaw Gateway health.",
    capability: "system",
    risk: "read",
    paramsExample: {}
  },
  {
    name: "status",
    title: "Status",
    description: "Read OpenClaw Gateway status summary.",
    capability: "system",
    risk: "read",
    paramsExample: {}
  },
  {
    name: "models.list",
    title: "Models",
    description: "List OpenClaw model catalog entries.",
    capability: "models",
    risk: "read",
    paramsExample: { view: "configured" }
  },
  {
    name: "sessions.list",
    title: "Sessions",
    description: "List OpenClaw sessions.",
    capability: "sessions",
    risk: "read",
    paramsExample: {}
  },
  {
    name: "sessions.patch",
    title: "Patch Session",
    description: "Patch OpenClaw session metadata.",
    capability: "sessions",
    risk: "write",
    paramsExample: { sessionKey: "session-key", title: "New title" }
  },
  {
    name: "sessions.usage",
    title: "Session Usage",
    description: "Read OpenClaw session usage summaries.",
    capability: "sessions",
    risk: "read",
    paramsExample: {}
  },
  {
    name: "agent",
    title: "Agent Run",
    description: "Start an OpenClaw agent request.",
    capability: "agent",
    risk: "write",
    paramsExample: { prompt: "Summarize this workspace", sessionKey: "uab-demo" }
  },
  {
    name: "agent.wait",
    title: "Wait Agent",
    description: "Wait for an OpenClaw agent run to finish.",
    capability: "agent",
    risk: "read",
    paramsExample: { runId: "run_abc123" }
  },
  {
    name: "agent.stream",
    title: "Stream Agent Run",
    description: "Start an OpenClaw agent request and forward Gateway events.",
    capability: "agent",
    risk: "write",
    paramsExample: { prompt: "Summarize this workspace", sessionKey: "uab-demo" }
  },
  {
    name: "chat.history",
    title: "Chat History",
    description: "Read OpenClaw chat history.",
    capability: "chat",
    risk: "read",
    paramsExample: { sessionKey: "session-key" }
  },
  {
    name: "chat.send",
    title: "Chat Send",
    description: "Send a chat message through OpenClaw Gateway.",
    capability: "chat",
    risk: "write",
    paramsExample: { sessionKey: "session-key", text: "Hello" }
  },
  {
    name: "chat.stream",
    title: "Chat Stream",
    description: "Send a chat message and forward OpenClaw Gateway events.",
    capability: "chat",
    risk: "write",
    paramsExample: { sessionKey: "session-key", text: "Hello" }
  },
  {
    name: "chat.abort",
    title: "Abort Chat",
    description: "Abort an active chat request.",
    capability: "chat",
    risk: "write",
    paramsExample: { sessionKey: "session-key" }
  },
  {
    name: "tasks.list",
    title: "Tasks",
    description: "List OpenClaw Gateway task ledger entries.",
    capability: "tasks",
    risk: "read",
    paramsExample: { status: "running", limit: 50 }
  },
  {
    name: "tasks.get",
    title: "Get Task",
    description: "Read one OpenClaw task summary.",
    capability: "tasks",
    risk: "read",
    paramsExample: { taskId: "task_abc123" }
  },
  {
    name: "tasks.cancel",
    title: "Cancel Task",
    description: "Cancel an OpenClaw task.",
    capability: "tasks",
    risk: "write",
    paramsExample: { taskId: "task_abc123", reason: "user requested" }
  },
  {
    name: "tools.catalog",
    title: "Tool Catalog",
    description: "Read OpenClaw tool catalog.",
    capability: "tools",
    risk: "read",
    paramsExample: {}
  },
  {
    name: "tools.effective",
    title: "Effective Tools",
    description: "Read session-effective OpenClaw tools.",
    capability: "tools",
    risk: "read",
    paramsExample: { sessionKey: "session-key" }
  },
  {
    name: "tools.invoke",
    title: "Invoke Tool",
    description: "Invoke an OpenClaw tool through Gateway policy.",
    capability: "tools",
    risk: "write",
    paramsExample: { name: "tool_name", args: {}, sessionKey: "session-key" }
  },
  {
    name: "artifacts.list",
    title: "Artifacts",
    description: "List OpenClaw artifacts.",
    capability: "artifacts",
    risk: "read",
    paramsExample: { sessionKey: "session-key", limit: 50 }
  },
  {
    name: "artifacts.get",
    title: "Get Artifact",
    description: "Read one OpenClaw artifact.",
    capability: "artifacts",
    risk: "read",
    paramsExample: { artifactId: "artifact_abc123" }
  },
  {
    name: "artifacts.delete",
    title: "Delete Artifact",
    description: "Delete one OpenClaw artifact.",
    capability: "artifacts",
    risk: "write",
    paramsExample: { artifactId: "artifact_abc123" }
  },
  {
    name: "exec.approval.list",
    title: "Approvals",
    description: "List pending OpenClaw execution approvals.",
    capability: "approvals",
    risk: "read",
    paramsExample: { sessionKey: "session-key" }
  },
  {
    name: "exec.approval.resolve",
    title: "Resolve Approval",
    description: "Approve or reject an OpenClaw execution approval.",
    capability: "approvals",
    risk: "write",
    paramsExample: { approvalId: "approval_abc123", decision: "approve" }
  },
  {
    name: "skills.status",
    title: "Skills",
    description: "Read OpenClaw skill inventory.",
    capability: "skills",
    risk: "read",
    paramsExample: {}
  },
  {
    name: "skills.search",
    title: "Search Skills",
    description: "Search OpenClaw skills metadata.",
    capability: "skills",
    risk: "read",
    paramsExample: { query: "github" }
  },
  {
    name: "commands.list",
    title: "Commands",
    description: "Read OpenClaw runtime command inventory.",
    capability: "commands",
    risk: "read",
    paramsExample: {}
  },
  {
    name: "cron.list",
    title: "Cron",
    description: "List OpenClaw cron jobs.",
    capability: "cron",
    risk: "read",
    paramsExample: {}
  },
  {
    name: "config.get",
    title: "Config",
    description: "Read OpenClaw config snapshot.",
    capability: "config",
    risk: "read",
    paramsExample: {}
  },
  {
    name: "config.patch",
    title: "Patch Config",
    description: "Patch OpenClaw config.",
    capability: "config",
    risk: "admin",
    paramsExample: { patch: {} }
  },
  {
    name: "channels.status",
    title: "Channels",
    description: "Read OpenClaw channel status.",
    capability: "channels",
    risk: "read",
    paramsExample: {}
  },
  {
    name: "logs.tail",
    title: "Logs",
    description: "Tail OpenClaw Gateway logs.",
    capability: "logs",
    risk: "read",
    paramsExample: { limit: 100 }
  },
  {
    name: "gateway.call",
    title: "Raw Gateway RPC",
    description: "Call any documented OpenClaw Gateway RPC method.",
    capability: "gateway",
    risk: "admin",
    paramsExample: { method: "status", params: {} }
  }
];

const CAPABILITIES: RuntimeCapabilities = {
  system: { read: true, methods: ["health", "status"] },
  models: { read: true, methods: ["models.list"] },
  sessions: {
    read: true,
    write: true,
    methods: ["sessions.list", "sessions.patch", "sessions.usage"]
  },
  agent: { read: true, write: true, methods: ["agent", "agent.wait", "agent.stream"] },
  chat: {
    read: true,
    write: true,
    methods: ["chat.history", "chat.send", "chat.stream", "chat.abort"]
  },
  tasks: { read: true, write: true, methods: ["tasks.list", "tasks.get", "tasks.cancel"] },
  tools: { read: true, write: true, methods: ["tools.catalog", "tools.effective", "tools.invoke"] },
  artifacts: { read: true, write: true, methods: ["artifacts.list", "artifacts.get", "artifacts.delete"] },
  approvals: { read: true, write: true, methods: ["exec.approval.list", "exec.approval.resolve"] },
  skills: { read: true, methods: ["skills.status", "skills.search"] },
  commands: { read: true, methods: ["commands.list"] },
  cron: { read: true, methods: ["cron.list"] },
  config: { read: true, admin: true, methods: ["config.get", "config.patch"] },
  channels: { read: true, methods: ["channels.status"] },
  logs: { read: true, methods: ["logs.tail"] },
  gateway: { read: true, write: true, admin: true, methods: ["gateway.call"] }
};

export function createOpenClawAdapter(
  options: OpenClawAdapterOptions = {}
): AgentRuntimeAdapter {
  const mode = options.mode ?? "gateway";
  const timeoutMs = options.timeoutMs ?? 30_000;

  return {
    info: {
      id: options.id ?? "openclaw",
      name: options.name ?? "OpenClaw",
      description: mode === "gateway"
        ? `OpenClaw Gateway adapter for ${options.gatewayUrl ?? "ws://127.0.0.1:18789"}`
        : `OpenClaw CLI adapter using ${options.cliCommand ?? "openclaw"}`
    },
    capabilities() {
      return CAPABILITIES;
    },
    methods() {
      return DEFAULT_METHODS;
    },
    async health(): Promise<AdapterHealth> {
      try {
        const result = await callOpenClaw("health", {}, options, timeoutMs);
        return {
          status: "ok",
          details: toJsonValue(result)
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
      if (request.method === "gateway.call") {
        const params = readObjectParams(request.params);
        const method = readStringParam(params, "method");
        return callOpenClaw(method, params.params ?? {}, options, timeoutMs);
      }

      return callOpenClaw(request.method, request.params ?? {}, options, timeoutMs);
    },
    stream(request) {
      return streamOpenClaw(request, options, timeoutMs);
    }
  };
}

async function* streamOpenClaw(
  request: AdapterCallRequest,
  options: OpenClawAdapterOptions,
  timeoutMs: number
): AsyncIterable<AdapterStreamEvent> {
  const method = mapOpenClawStreamMethod(request.method);

  if (options.mode === "cli") {
    const result = await callOpenClawCli(
      method,
      request.params ?? {},
      options,
      timeoutMs
    );
    yield {
      type: "result",
      data: toJsonValue(result)
    };
    return;
  }

  const queue = createAsyncQueue<AdapterStreamEvent>();
  void callOpenClawGatewayWithEvents(method, request.params ?? {}, options, timeoutMs, (event) => {
    queue.push(openClawEventToStreamEvent(event));
  }).then((result) => {
    queue.push({
      type: "result",
      data: toJsonValue(result.payload)
    });
    queue.end();
  }, (error) => {
    queue.fail(error);
  });

  for await (const event of queue) {
    yield event;
  }
}

async function callOpenClaw(
  method: string,
  params: unknown,
  options: OpenClawAdapterOptions,
  timeoutMs: number
): Promise<unknown> {
  if (options.mode === "cli") {
    return callOpenClawCli(method, params, options, timeoutMs);
  }

  return callOpenClawGateway(method, params, options, timeoutMs);
}

async function callOpenClawGateway(
  method: string,
  params: unknown,
  options: OpenClawAdapterOptions,
  timeoutMs: number
): Promise<unknown> {
  const result = await callOpenClawGatewayWithEvents(method, params, options, timeoutMs);
  return result.payload;
}

async function callOpenClawGatewayWithEvents(
  method: string,
  params: unknown,
  options: OpenClawAdapterOptions,
  timeoutMs: number,
  onEvent?: (event: OpenClawGatewayEvent) => void
): Promise<{ payload: unknown; events: OpenClawGatewayEvent[] }> {
  const WebSocketCtor = globalThis.WebSocket as unknown as WebSocketConstructor | undefined;
  if (!WebSocketCtor) {
    throw new AdapterError("OpenClaw Gateway mode requires a Node.js runtime with global WebSocket support.", {
      code: BRIDGE_ERROR_CODES.adapterUnavailable
    });
  }

  const socket = new WebSocketCtor(options.gatewayUrl ?? "ws://127.0.0.1:18789");
  const pending = new Map<string, {
    resolve(value: unknown): void;
    reject(error: Error): void;
  }>();
  let connected = false;
  let closed = false;
  let counter = 0;
  const events: OpenClawGatewayEvent[] = [];

  const sendRequest = (requestMethod: string, requestParams: unknown) => {
    const id = `uab_${Date.now().toString(36)}_${counter++}`;
    const frame: GatewayFrame = {
      type: "req",
      id,
      method: requestMethod,
      params: requestParams
    };

    const promise = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });

    socket.send(JSON.stringify(frame));
    return promise;
  };

  const waitForOpen = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("OpenClaw Gateway WebSocket failed to open.")));
    socket.addEventListener("close", () => {
      if (!connected) reject(new Error("OpenClaw Gateway WebSocket closed before connect."));
    });
  });

  socket.addEventListener("message", (event) => {
    const frame = parseGatewayFrame(event.data);
    if (!frame) return;

    if (frame.type === "event") {
      const gatewayEvent: OpenClawGatewayEvent = {
        event: frame.event,
        payload: toJsonValue(frame.payload),
        seq: frame.seq,
        stateVersion: frame.stateVersion
      };
      events.push(gatewayEvent);
      onEvent?.(gatewayEvent);
      return;
    }

    if (frame.type !== "res") return;

    const entry = pending.get(frame.id);
    if (!entry) return;
    pending.delete(frame.id);

    if (frame.ok) {
      entry.resolve(frame.payload ?? null);
    } else {
      entry.reject(openClawFrameError(frame.error));
    }
  });

  socket.addEventListener("close", () => {
    closed = true;
    for (const entry of pending.values()) {
      entry.reject(new AdapterError("OpenClaw Gateway WebSocket closed.", {
        code: BRIDGE_ERROR_CODES.adapterUnavailable
      }));
    }
    pending.clear();
  });

  const timeout = setTimeout(() => {
    socket.close();
    for (const entry of pending.values()) {
      entry.reject(new AdapterError("OpenClaw Gateway request timed out.", {
        code: BRIDGE_ERROR_CODES.timeout
      }));
    }
    pending.clear();
  }, timeoutMs);

  try {
    await waitForOpen;
    await sendRequest("connect", {
      minProtocol: 4,
      maxProtocol: 4,
      client: {
        id: "gateway-client",
        version: "0.1.0",
        platform: process.platform,
        mode: "backend"
      },
      role: "operator",
      scopes: options.scopes ?? ["operator.read", "operator.write"],
      caps: [],
      commands: [],
      permissions: {},
      auth: buildOpenClawAuth(options),
      locale: "en-US",
      userAgent: "universal-agent-bridge/0.1.0"
    });
    connected = true;
    return {
      payload: await sendRequest(method, params),
      events
    };
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw new AdapterError(error instanceof Error ? error.message : String(error), {
      code: BRIDGE_ERROR_CODES.adapterUnavailable
    });
  } finally {
    clearTimeout(timeout);
    if (!closed) socket.close();
  }
}

async function callOpenClawCli(
  method: string,
  params: unknown,
  options: OpenClawAdapterOptions,
  timeoutMs: number
): Promise<unknown> {
  const command = options.cliCommand ?? "openclaw";
  const args = buildOpenClawCliArgs(method, params);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new AdapterError("OpenClaw CLI request timed out.", {
        code: BRIDGE_ERROR_CODES.timeout
      }));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(new AdapterError(`OpenClaw CLI failed: ${error.message}`, {
        code: BRIDGE_ERROR_CODES.adapterUnavailable
      }));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new AdapterError(`OpenClaw CLI exited with code ${code}.`, {
          code: BRIDGE_ERROR_CODES.adapterUnavailable,
          data: { stderr: stderr.trim() }
        }));
        return;
      }

      try {
        resolve(JSON.parse(stdout) as JsonValue);
      } catch {
        resolve({ output: stdout.trim() });
      }
    });
  });
}

function buildOpenClawCliArgs(method: string, params: unknown): string[] {
  const object = isJsonObject(params) ? params as JsonObject : {};

  switch (method) {
    case "health":
      return ["gateway", "call", "health", "--json", "--timeout", readCliTimeout(object)];
    case "status":
      return ["gateway", "call", "status", "--json", "--timeout", readCliTimeout(object)];
    case "sessions.list":
      return compactArgs([
        "sessions",
        "list",
        "--json",
        "--limit",
        readStringLike(object.limit, "100"),
        readFlag(object.all_agents, "--all-agents"),
        readStringArg(object.agent, "--agent"),
        readStringArg(object.active, "--active"),
        readStringArg(object.store, "--store")
      ]);
    case "models.list":
      if (!object.catalog && !object.all && !object.provider && !object.local) {
        return compactArgs([
          "models",
          "status",
          "--json",
          readStringArg(object.agent, "--agent")
        ]);
      }
      return compactArgs([
        "models",
        "list",
        "--json",
        readFlag(object.all, "--all"),
        readFlag(object.local, "--local"),
        readStringArg(object.provider, "--provider")
      ]);
    case "tasks.list":
      return compactArgs([
        "tasks",
        "list",
        "--json",
        readStringArg(object.status, "--status"),
        readStringArg(object.runtime, "--runtime")
      ]);
    case "tasks.get":
      return ["tasks", "show", readTaskLookup(object), "--json"];
    case "tasks.cancel":
      return ["tasks", "cancel", readTaskLookup(object), "--json"];
    case "channels.status":
      return compactArgs([
        "channels",
        "status",
        "--json",
        readStringArg(object.channel, "--channel"),
        readFlag(object.probe, "--probe"),
        "--timeout",
        readCliTimeout(object)
      ]);
    case "skills.status":
    case "skills.listInstalled":
      return compactArgs([
        "skills",
        "list",
        "--json",
        readFlag(object.eligible, "--eligible"),
        readFlag(object.verbose, "--verbose"),
        readStringArg(object.agent, "--agent")
      ]);
    case "skills.search":
      return compactArgs([
        "skills",
        "search",
        ...readSearchQuery(object),
        "--json",
        readStringArg(object.limit, "--limit")
      ]);
    case "cron.list":
      return compactArgs([
        "cron",
        "list",
        "--json",
        readFlag(object.all, "--all"),
        readStringArg(object.agent, "--agent"),
        "--timeout",
        readCliTimeout(object)
      ]);
    case "config.get":
      return ["config", "get", readConfigPath(object), "--json"];
    case "exec.approval.list":
      return compactArgs([
        "approvals",
        "get",
        "--json",
        readFlag(object.gateway, "--gateway"),
        readStringArg(object.node, "--node"),
        "--timeout",
        readCliTimeout(object)
      ]);
    case "logs.tail":
      return compactArgs([
        "logs",
        "--json",
        "--limit",
        readStringLike(object.limit, "200"),
        readStringArg(object.maxBytes ?? object.max_bytes, "--max-bytes"),
        "--timeout",
        readCliTimeout(object)
      ]);
    default:
      return ["gateway", "call", method, "--params", JSON.stringify(params ?? {}), "--json"];
  }
}

function buildOpenClawAuth(options: OpenClawAdapterOptions): JsonObject {
  const auth: JsonObject = {};
  if (options.token) auth.token = options.token;
  if (options.password) auth.password = options.password;
  return auth;
}

function parseGatewayFrame(data: unknown): GatewayFrame | undefined {
  try {
    const text = typeof data === "string" ? data : String(data);
    const parsed = JSON.parse(text) as GatewayFrame;
    return parsed;
  } catch {
    return undefined;
  }
}

function openClawFrameError(error: unknown): AdapterError {
  if (isJsonObject(error)) {
    const message = typeof error.message === "string"
      ? error.message
      : "OpenClaw Gateway returned an error.";
    return new AdapterError(message, {
      code: typeof error.code === "number" ? error.code : BRIDGE_ERROR_CODES.adapterUnavailable,
      data: toJsonValue(error)
    });
  }

  return new AdapterError("OpenClaw Gateway returned an error.", {
    code: BRIDGE_ERROR_CODES.adapterUnavailable
  });
}

function mapOpenClawStreamMethod(method: string): string {
  if (method === "agent.stream") return "agent";
  if (method === "chat.stream") return "chat.send";
  return method;
}

function openClawEventToStreamEvent(event: OpenClawGatewayEvent): AdapterStreamEvent {
  const name = event.event;
  const payload = event.payload ?? null;
  const lower = name.toLowerCase();
  const text = extractOpenClawText(payload);

  if (text) {
    return {
      type: "text",
      delta: text
    };
  }

  if (lower.includes("tool")) {
    return {
      type: "tool_call",
      name: readPayloadString(payload, "name") ?? readPayloadString(payload, "toolName") ?? name,
      data: payload
    };
  }

  if (lower.includes("artifact")) {
    return {
      type: "artifact",
      data: payload
    };
  }

  if (lower.includes("approval")) {
    return {
      type: "custom",
      name: "approval",
      data: payload
    };
  }

  if (lower.includes("error")) {
    return {
      type: "error",
      message: readPayloadString(payload, "message") ?? "OpenClaw Gateway event error.",
      data: payload
    };
  }

  if (isJsonObject(payload) && (isJsonObject(payload.a2ui) || isJsonObject(payload.ui))) {
    return {
      type: "a2ui",
      data: payload
    };
  }

  return {
    type: "custom",
    name,
    data: {
      event: name,
      seq: event.seq ?? null,
      stateVersion: event.stateVersion ?? null,
      payload
    }
  };
}

function extractOpenClawText(value: JsonValue): string | undefined {
  if (typeof value === "string") return value;
  if (!isJsonObject(value)) return undefined;

  for (const key of ["delta", "text", "content", "message"]) {
    const entry = value[key];
    if (typeof entry === "string" && entry.length > 0) return entry;
  }

  return undefined;
}

function readPayloadString(value: JsonValue, key: string): string | undefined {
  if (!isJsonObject(value)) return undefined;
  const entry = value[key];
  return typeof entry === "string" && entry.trim() !== "" ? entry.trim() : undefined;
}

function compactArgs(values: Array<string | string[] | undefined>): string[] {
  return values.flatMap((value) => {
    if (value === undefined) return [];
    return Array.isArray(value) ? value : [value];
  });
}

function readFlag(value: unknown, flag: string): string | undefined {
  return value === true ? flag : undefined;
}

function readStringArg(value: unknown, flag: string): string[] | undefined {
  if (typeof value === "string" && value.trim() !== "") {
    return [flag, value.trim()];
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return [flag, String(value)];
  }
  return undefined;
}

function readStringLike(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function readCliTimeout(params: JsonObject): string {
  return readStringLike(params.timeoutMs ?? params.timeout_ms ?? params.timeout, "30000");
}

function readTaskLookup(params: JsonObject): string {
  const value = params.taskId ?? params.task_id ?? params.runId ?? params.run_id ?? params.sessionKey ?? params.session_key ?? params.lookup;
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  throw new AdapterError("Parameter 'taskId' is required.", {
    code: BRIDGE_ERROR_CODES.invalidParams
  });
}

function readConfigPath(params: JsonObject): string {
  const value = params.path ?? params.key;
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return ".";
}

function readSearchQuery(params: JsonObject): string[] {
  const query = params.query ?? params.q;
  if (typeof query === "string" && query.trim() !== "") {
    return query.trim().split(/\s+/);
  }
  if (Array.isArray(query)) {
    return query
      .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
      .map((entry) => entry.trim());
  }
  return [];
}

function createAsyncQueue<T>(): AsyncIterable<T> & {
  push(value: T): void;
  end(): void;
  fail(error: unknown): void;
} {
  const values: T[] = [];
  const waiters: Array<{
    resolve(result: IteratorResult<T>): void;
    reject(error: unknown): void;
  }> = [];
  let done = false;
  let failure: unknown;

  return {
    push(value: T) {
      if (done) return;
      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve({ value, done: false });
      } else {
        values.push(value);
      }
    },
    end() {
      done = true;
      for (const waiter of waiters.splice(0)) {
        waiter.resolve({ value: undefined, done: true });
      }
    },
    fail(error: unknown) {
      failure = error;
      done = true;
      for (const waiter of waiters.splice(0)) {
        waiter.reject(error);
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          if (values.length > 0) {
            return Promise.resolve({ value: values.shift()!, done: false });
          }
          if (failure) return Promise.reject(failure);
          if (done) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
        }
      };
    }
  };
}

function readObjectParams(params: unknown): JsonObject {
  if (!isJsonObject(params)) {
    throw new AdapterError("Object params are required.", {
      code: BRIDGE_ERROR_CODES.invalidParams
    });
  }
  return params as JsonObject;
}

function readStringParam(params: JsonObject, key: string): string {
  const value = params[key];
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }
  throw new AdapterError(`Parameter '${key}' is required.`, {
    code: BRIDGE_ERROR_CODES.invalidParams
  });
}

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
