import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
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

export type McpTransport = "stdio" | "http";

export interface McpServerConfig {
  id: string;
  name?: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  shell?: boolean;
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  protocolVersion?: string;
  timeoutMs?: number;
}

export interface McpAdapterOptions {
  id?: string;
  name?: string;
  servers: McpServerConfig[];
}

export interface McpToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: unknown;
  [key: string]: unknown;
}

export interface McpListToolsResult {
  tools: McpToolDefinition[];
  nextCursor?: string;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

interface McpClient {
  listTools(cursor?: string): Promise<McpListToolsResult>;
  callTool(name: string, args: JsonObject): Promise<unknown>;
  stop(): Promise<void>;
}

const DEFAULT_PROTOCOL_VERSION = "2025-11-25";
const DEFAULT_TIMEOUT_MS = 30_000;

const METHODS: RuntimeMethodDefinition[] = [
  {
    name: "mcp.servers.list",
    title: "MCP Servers",
    description: "List configured MCP servers.",
    capability: "mcp",
    risk: "read",
    paramsExample: {}
  },
  {
    name: "mcp.tools.list",
    title: "MCP Tools",
    description: "List tools exposed by one or all MCP servers.",
    capability: "tools",
    risk: "read",
    paramsExample: { serverId: "example" }
  },
  {
    name: "mcp.tools.call",
    title: "Call MCP Tool",
    description: "Invoke a tool through its MCP server.",
    capability: "tools",
    risk: "write",
    paramsExample: {
      serverId: "example",
      name: "echo",
      arguments: { text: "hello" }
    }
  }
];

const CAPABILITIES: RuntimeCapabilities = {
  mcp: { read: true, methods: ["mcp.servers.list"] },
  tools: { read: true, write: true, methods: ["mcp.tools.list", "mcp.tools.call"] }
};

export function createMcpAdapter(options: McpAdapterOptions): AgentRuntimeAdapter {
  const registry = new McpToolRegistry(options.servers);

  return {
    info: {
      id: options.id ?? "mcp",
      name: options.name ?? "MCP Tool Layer",
      description: "MCP tool registry for Universal Agent Bridge."
    },
    capabilities() {
      return CAPABILITIES;
    },
    methods() {
      return METHODS;
    },
    health(): AdapterHealth {
      return {
        status: options.servers.length > 0 ? "ok" : "degraded",
        details: {
          serverCount: options.servers.length
        }
      };
    },
    async call(request) {
      switch (request.method) {
        case "mcp.servers.list":
          return {
            servers: registry.listServers()
          };
        case "mcp.tools.list":
          return registry.listTools(readOptionalStringParam(request.params, "serverId"));
        case "mcp.tools.call": {
          const params = readObjectParams(request.params);
          const serverId = readStringParam(params, "serverId", registry.defaultServerId());
          const name = readStringParam(params, "name");
          const args = readObjectParam(params, "arguments", {});
          return registry.callTool(serverId, name, args);
        }
        default:
          throw new AdapterError(`Method '${request.method}' is not supported by MCP adapter.`, {
            code: BRIDGE_ERROR_CODES.methodNotFound,
            data: { method: request.method }
          });
      }
    },
    async stop() {
      await registry.stopAll();
    }
  };
}

export function readMcpServerConfigsFromEnv(
  env: Record<string, string | undefined>
): McpServerConfig[] {
  const configured = env.UAB_MCP_SERVERS;
  if (configured) {
    const parsed = JSON.parse(configured) as McpServerConfig[];
    if (!Array.isArray(parsed)) {
      throw new Error("UAB_MCP_SERVERS must be a JSON array.");
    }
    return parsed.map(normalizeServerConfig);
  }

  const command = env.UAB_MCP_SERVER_COMMAND;
  const url = env.UAB_MCP_SERVER_URL;
  if (!command && !url) return [];

  const transport = (env.UAB_MCP_SERVER_TRANSPORT ?? (url ? "http" : "stdio")) as McpTransport;
  return [
    normalizeServerConfig({
      id: env.UAB_MCP_SERVER_ID ?? "default",
      name: env.UAB_MCP_SERVER_NAME,
      transport,
      command,
      args: parseStringArray(env.UAB_MCP_SERVER_ARGS),
      shell: parseBoolean(env.UAB_MCP_SERVER_SHELL),
      cwd: env.UAB_MCP_SERVER_CWD,
      env: parseRecord(env.UAB_MCP_SERVER_ENV_JSON),
      url,
      headers: parseRecord(env.UAB_MCP_SERVER_HEADERS_JSON),
      protocolVersion: env.UAB_MCP_PROTOCOL_VERSION,
      timeoutMs: parseNumber(env.UAB_MCP_TIMEOUT_MS)
    })
  ];
}

export class McpToolRegistry {
  private readonly configs = new Map<string, McpServerConfig>();
  private readonly clients = new Map<string, McpClient>();

  constructor(configs: McpServerConfig[]) {
    for (const config of configs.map(normalizeServerConfig)) {
      if (this.configs.has(config.id)) {
        throw new Error(`Duplicate MCP server id '${config.id}'.`);
      }
      this.configs.set(config.id, config);
    }
  }

  listServers(): JsonValue {
    return toJsonValue([...this.configs.values()].map(redactServerConfig));
  }

  defaultServerId(): string | undefined {
    if (this.configs.size === 1) {
      return [...this.configs.keys()][0];
    }
    return undefined;
  }

  async listTools(serverId?: string): Promise<JsonValue> {
    const configs = serverId
      ? [this.requireConfig(serverId)]
      : [...this.configs.values()];

    const servers = await Promise.all(
      configs.map(async (config) => {
        const result = await this.client(config.id).listTools();
        return {
          server: redactServerConfig(config),
          tools: result.tools,
          nextCursor: result.nextCursor
        };
      })
    );

    return toJsonValue({ servers });
  }

  async callTool(serverId: string | undefined, name: string, args: JsonObject): Promise<JsonValue> {
    const resolvedServerId = serverId ?? this.defaultServerId();
    if (!resolvedServerId) {
      throw new AdapterError("Parameter 'serverId' is required when multiple MCP servers are configured.", {
        code: BRIDGE_ERROR_CODES.invalidParams
      });
    }

    this.requireConfig(resolvedServerId);
    const result = await this.client(resolvedServerId).callTool(name, args);
    return toJsonValue({
      serverId: resolvedServerId,
      tool: name,
      result
    });
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.clients.values()].map((client) => client.stop()));
    this.clients.clear();
  }

  private requireConfig(id: string): McpServerConfig {
    const config = this.configs.get(id);
    if (!config) {
      throw new AdapterError(`MCP server '${id}' is not configured.`, {
        code: BRIDGE_ERROR_CODES.runtimeNotFound,
        data: { serverId: id }
      });
    }
    return config;
  }

  private client(id: string): McpClient {
    const existing = this.clients.get(id);
    if (existing) return existing;

    const config = this.requireConfig(id);
    const client = config.transport === "stdio"
      ? new StdioMcpClient(config)
      : new HttpMcpClient(config);
    this.clients.set(id, client);
    return client;
  }
}

class StdioMcpClient implements McpClient {
  private child?: ChildProcessWithoutNullStreams;
  private lines?: ReadlineInterface;
  private initialized?: Promise<void>;
  private nextId = 1;
  private readonly pending = new Map<string | number, PendingRequest>();
  private stderr = "";

  constructor(private readonly config: McpServerConfig) {}

  async listTools(cursor?: string): Promise<McpListToolsResult> {
    await this.ensureInitialized();
    const result = await this.request("tools/list", cursor ? { cursor } : {});
    return normalizeListToolsResult(result);
  }

  async callTool(name: string, args: JsonObject): Promise<unknown> {
    await this.ensureInitialized();
    return this.request("tools/call", {
      name,
      arguments: args
    });
  }

  async stop(): Promise<void> {
    this.lines?.close();
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.rejectAll(new Error("MCP stdio client stopped."));
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.initialize();
    }
    return this.initialized;
  }

  private async initialize(): Promise<void> {
    this.start();
    await this.request("initialize", {
      protocolVersion: this.config.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "universal-agent-bridge",
        version: "0.1.0"
      }
    });
    this.notify("notifications/initialized", {});
  }

  private start(): void {
    if (this.child) return;
    if (!this.config.command) {
      throw new AdapterError("MCP stdio server requires a command.", {
        code: BRIDGE_ERROR_CODES.invalidParams
      });
    }

    this.child = spawn(this.config.command, this.config.args ?? [], {
      cwd: this.config.cwd,
      env: {
        ...process.env,
        ...this.config.env
      },
      shell: this.config.shell ?? false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");

    this.lines = createInterface({
      input: this.child.stdout
    });
    this.lines.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-4000);
    });
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("exit", (code) => {
      this.rejectAll(new Error(`MCP stdio server exited with code ${code}. ${this.stderr.trim()}`.trim()));
    });
  }

  private request(method: string, params: JsonObject): Promise<unknown> {
    this.start();
    const id = this.nextId++;
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };

    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new AdapterError(`MCP stdio request '${method}' timed out.`, {
          code: BRIDGE_ERROR_CODES.timeout
        }));
      }, this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout });
    });

    this.child!.stdin.write(`${JSON.stringify(payload)}\n`);
    return promise;
  }

  private notify(method: string, params: JsonObject): void {
    this.start();
    this.child!.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      method,
      params
    })}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let response: JsonRpcResponse;
    try {
      response = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }

    if (response.id === undefined || response.id === null) return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timeout);

    if (response.error) {
      pending.reject(new AdapterError(response.error.message ?? "MCP stdio request failed.", {
        code: response.error.code ?? BRIDGE_ERROR_CODES.adapterUnavailable,
        data: toJsonValue(response.error.data)
      }));
      return;
    }

    pending.resolve(response.result ?? null);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }
}

class HttpMcpClient implements McpClient {
  private initialized?: Promise<void>;
  private nextId = 1;
  private sessionId?: string;

  constructor(private readonly config: McpServerConfig) {}

  async listTools(cursor?: string): Promise<McpListToolsResult> {
    await this.ensureInitialized();
    const result = await this.request("tools/list", cursor ? { cursor } : {});
    return normalizeListToolsResult(result);
  }

  async callTool(name: string, args: JsonObject): Promise<unknown> {
    await this.ensureInitialized();
    return this.request("tools/call", {
      name,
      arguments: args
    });
  }

  async stop(): Promise<void> {
    this.initialized = undefined;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.initialize();
    }
    return this.initialized;
  }

  private async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: this.config.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "universal-agent-bridge",
        version: "0.1.0"
      }
    });
    await this.notification("notifications/initialized", {});
  }

  private request(method: string, params: JsonObject): Promise<unknown> {
    const id = this.nextId++;
    return this.post({
      jsonrpc: "2.0",
      id,
      method,
      params
    }, id);
  }

  private async notification(method: string, params: JsonObject): Promise<void> {
    await this.post({
      jsonrpc: "2.0",
      method,
      params
    });
  }

  private async post(payload: unknown, expectedId?: string | number): Promise<unknown> {
    if (!this.config.url) {
      throw new AdapterError("MCP HTTP server requires a url.", {
        code: BRIDGE_ERROR_CODES.invalidParams
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );

    try {
      const response = await fetch(this.config.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": this.config.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
          ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
          ...this.config.headers
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const sessionId = response.headers.get("mcp-session-id");
      if (sessionId) this.sessionId = sessionId;

      if (!response.ok) {
        throw new AdapterError(`MCP HTTP server returned HTTP ${response.status}.`, {
          code: BRIDGE_ERROR_CODES.adapterUnavailable,
          data: { body: await response.text().catch(() => "") }
        });
      }

      if (expectedId === undefined) {
        return null;
      }

      const rpcResponse = await readMcpHttpResponse(response, expectedId);
      if (rpcResponse.error) {
        throw new AdapterError(rpcResponse.error.message ?? "MCP HTTP request failed.", {
          code: rpcResponse.error.code ?? BRIDGE_ERROR_CODES.adapterUnavailable,
          data: toJsonValue(rpcResponse.error.data)
        });
      }
      return rpcResponse.result ?? null;
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new AdapterError(`MCP HTTP request failed: ${message}`, {
        code: message.includes("abort") ? BRIDGE_ERROR_CODES.timeout : BRIDGE_ERROR_CODES.adapterUnavailable
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readMcpHttpResponse(
  response: Response,
  expectedId: string | number
): Promise<JsonRpcResponse> {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (contentType.includes("text/event-stream")) {
    const events = text
      .split("\n\n")
      .flatMap((chunk) => chunk.split("\n").filter((line) => line.startsWith("data:")))
      .map((line) => line.slice(5).trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JsonRpcResponse);
    const match = events.find((event) => event.id === expectedId);
    if (match) return match;
    throw new AdapterError("MCP HTTP SSE response did not include the expected response id.", {
      code: BRIDGE_ERROR_CODES.adapterUnavailable
    });
  }

  const parsed = JSON.parse(text) as JsonRpcResponse;
  return parsed;
}

function normalizeServerConfig(config: McpServerConfig): McpServerConfig {
  if (!config.id || !config.id.trim()) {
    throw new Error("MCP server id is required.");
  }
  if (config.transport !== "stdio" && config.transport !== "http") {
    throw new Error(`Unsupported MCP transport '${config.transport}'.`);
  }
  if (config.transport === "stdio" && !config.command) {
    throw new Error(`MCP stdio server '${config.id}' requires command.`);
  }
  if (config.transport === "http" && !config.url) {
    throw new Error(`MCP HTTP server '${config.id}' requires url.`);
  }
  return {
    ...config,
    id: config.id.trim(),
    name: config.name?.trim() || config.id.trim(),
    args: config.args ?? [],
    shell: config.shell ?? false,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    protocolVersion: config.protocolVersion ?? DEFAULT_PROTOCOL_VERSION
  };
}

function normalizeListToolsResult(value: unknown): McpListToolsResult {
  if (!isJsonObject(value)) {
    throw new AdapterError("MCP tools/list returned a non-object result.", {
      code: BRIDGE_ERROR_CODES.adapterUnavailable
    });
  }
  const tools = Array.isArray(value.tools) ? value.tools : [];
  return {
    tools: tools.map((tool) => isJsonObject(tool) ? tool as McpToolDefinition : { name: String(tool) }),
    nextCursor: typeof value.nextCursor === "string" ? value.nextCursor : undefined
  };
}

function redactServerConfig(config: McpServerConfig): JsonObject {
  return {
    id: config.id,
    name: config.name ?? config.id,
    transport: config.transport,
    command: config.command ?? null,
    args: config.args ?? [],
    shell: config.shell ?? false,
    cwd: config.cwd ?? null,
    url: config.url ?? null,
    protocolVersion: config.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    envKeys: config.env ? Object.keys(config.env) : [],
    headerKeys: config.headers ? Object.keys(config.headers) : []
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

function readObjectParam(params: JsonObject, key: string, fallback: JsonObject): JsonObject {
  const value = params[key];
  if (value === undefined) return fallback;
  if (isJsonObject(value)) return value as JsonObject;
  throw new AdapterError(`Parameter '${key}' must be an object.`, {
    code: BRIDGE_ERROR_CODES.invalidParams
  });
}

function readStringParam(params: JsonObject, key: string, fallback?: string): string {
  const value = params[key] ?? fallback;
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }
  throw new AdapterError(`Parameter '${key}' is required.`, {
    code: BRIDGE_ERROR_CODES.invalidParams
  });
}

function readOptionalStringParam(params: unknown, key: string): string | undefined {
  if (!isJsonObject(params)) return undefined;
  const value = params[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function parseStringArray(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as string[];
    return Array.isArray(parsed) ? parsed.map(String) : undefined;
  }
  return trimmed.split(" ").map((entry) => entry.trim()).filter(Boolean);
}

function parseRecord(value: string | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(value) as Record<string, string>;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
