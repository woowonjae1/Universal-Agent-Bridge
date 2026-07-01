import { spawn } from "node:child_process";
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
  agent: { read: true, write: true, methods: ["agent", "agent.wait"] },
  chat: {
    read: true,
    write: true,
    methods: ["chat.history", "chat.send", "chat.abort"]
  },
  tasks: { read: true, write: true, methods: ["tasks.list", "tasks.get", "tasks.cancel"] },
  tools: { read: true, write: true, methods: ["tools.catalog", "tools.effective", "tools.invoke"] },
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
    }
  };
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
    if (!frame || frame.type !== "res") return;

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
    return await sendRequest(method, params);
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
  const args = ["gateway", "call", method, "--params", JSON.stringify(params ?? {}), "--json"];

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
