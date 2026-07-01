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

export interface A2aAgentConfig {
  id: string;
  name?: string;
  baseUrl?: string;
  cardUrl?: string;
  rpcUrl?: string;
  token?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  version?: string;
}

export interface A2aAdapterOptions {
  id?: string;
  name?: string;
  agents: A2aAgentConfig[];
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

interface AgentBinding {
  config: A2aAgentConfig;
  card?: JsonObject;
  rpcUrl?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_A2A_VERSION = "1.0";

const METHODS: RuntimeMethodDefinition[] = [
  {
    name: "a2a.agents.list",
    title: "A2A Agents",
    description: "List configured remote A2A agents and their discovered cards.",
    capability: "agents",
    risk: "read",
    paramsExample: {}
  },
  {
    name: "a2a.agent.card",
    title: "Agent Card",
    description: "Fetch one remote A2A Agent Card.",
    capability: "agents",
    risk: "read",
    paramsExample: { agentId: "example" }
  },
  {
    name: "a2a.message.send",
    title: "Send Message",
    description: "Send a message to a remote A2A agent through JSON-RPC SendMessage.",
    capability: "messages",
    risk: "write",
    paramsExample: { agentId: "example", text: "Hello from UAB" }
  },
  {
    name: "a2a.task.get",
    title: "Get Task",
    description: "Read a remote A2A task through GetTask.",
    capability: "tasks",
    risk: "read",
    paramsExample: { agentId: "example", id: "task_123", historyLength: 10 }
  },
  {
    name: "a2a.tasks.list",
    title: "List Tasks",
    description: "List remote A2A tasks through ListTasks.",
    capability: "tasks",
    risk: "read",
    paramsExample: { agentId: "example", pageSize: 20 }
  },
  {
    name: "a2a.task.cancel",
    title: "Cancel Task",
    description: "Cancel a remote A2A task through CancelTask.",
    capability: "tasks",
    risk: "write",
    paramsExample: { agentId: "example", id: "task_123" }
  },
  {
    name: "a2a.agent.extendedCard",
    title: "Extended Agent Card",
    description: "Fetch authenticated extended Agent Card through GetExtendedAgentCard.",
    capability: "agents",
    risk: "read",
    paramsExample: { agentId: "example" }
  },
  {
    name: "a2a.rpc.call",
    title: "Raw A2A RPC",
    description: "Call any A2A JSON-RPC method by name.",
    capability: "agents",
    risk: "admin",
    paramsExample: { agentId: "example", method: "SendMessage", params: {} }
  }
];

const CAPABILITIES: RuntimeCapabilities = {
  agents: {
    read: true,
    admin: true,
    methods: ["a2a.agents.list", "a2a.agent.card", "a2a.agent.extendedCard", "a2a.rpc.call"]
  },
  messages: { write: true, methods: ["a2a.message.send"] },
  tasks: {
    read: true,
    write: true,
    methods: ["a2a.task.get", "a2a.tasks.list", "a2a.task.cancel"]
  }
};

export function createA2aAdapter(options: A2aAdapterOptions): AgentRuntimeAdapter {
  const registry = new A2aAgentRegistry(options.agents);

  return {
    info: {
      id: options.id ?? "a2a",
      name: options.name ?? "A2A Agent Layer",
      description: "A2A remote agent registry and JSON-RPC client."
    },
    capabilities() {
      return CAPABILITIES;
    },
    methods() {
      return METHODS;
    },
    health(): AdapterHealth {
      return {
        status: options.agents.length > 0 ? "ok" : "degraded",
        details: {
          agentCount: options.agents.length
        }
      };
    },
    async call(request) {
      switch (request.method) {
        case "a2a.agents.list":
          return registry.listAgents();
        case "a2a.agent.card":
          return registry.getAgentCard(readAgentId(request.params, registry.defaultAgentId()));
        case "a2a.message.send": {
          const params = readObjectParams(request.params);
          const agentId = readStringParam(params, "agentId", registry.defaultAgentId());
          return registry.sendMessage(agentId, buildSendMessageParams(params));
        }
        case "a2a.task.get": {
          const params = readObjectParams(request.params);
          const agentId = readStringParam(params, "agentId", registry.defaultAgentId());
          return registry.call(agentId, "GetTask", stripAgentId(params));
        }
        case "a2a.tasks.list": {
          const params = readObjectParams(request.params, true);
          const agentId = readStringParam(params, "agentId", registry.defaultAgentId());
          return registry.call(agentId, "ListTasks", stripAgentId(params));
        }
        case "a2a.task.cancel": {
          const params = readObjectParams(request.params);
          const agentId = readStringParam(params, "agentId", registry.defaultAgentId());
          return registry.call(agentId, "CancelTask", stripAgentId(params));
        }
        case "a2a.agent.extendedCard": {
          const params = readObjectParams(request.params, true);
          const agentId = readStringParam(params, "agentId", registry.defaultAgentId());
          return registry.call(agentId, "GetExtendedAgentCard", {});
        }
        case "a2a.rpc.call": {
          const params = readObjectParams(request.params);
          const agentId = readStringParam(params, "agentId", registry.defaultAgentId());
          const method = readStringParam(params, "method");
          return registry.call(agentId, method, readObjectParam(params, "params", {}));
        }
        default:
          throw new AdapterError(`Method '${request.method}' is not supported by A2A adapter.`, {
            code: BRIDGE_ERROR_CODES.methodNotFound,
            data: { method: request.method }
          });
      }
    }
  };
}

export function readA2aAgentConfigsFromEnv(
  env: Record<string, string | undefined>
): A2aAgentConfig[] {
  const configured = env.UAB_A2A_AGENTS;
  if (configured) {
    const parsed = JSON.parse(configured) as A2aAgentConfig[];
    if (!Array.isArray(parsed)) {
      throw new Error("UAB_A2A_AGENTS must be a JSON array.");
    }
    return parsed.map(normalizeAgentConfig);
  }

  const baseUrl = env.UAB_A2A_AGENT_URL;
  const cardUrl = env.UAB_A2A_AGENT_CARD_URL;
  const rpcUrl = env.UAB_A2A_AGENT_RPC_URL;
  if (!baseUrl && !cardUrl && !rpcUrl) return [];

  return [
    normalizeAgentConfig({
      id: env.UAB_A2A_AGENT_ID ?? "default",
      name: env.UAB_A2A_AGENT_NAME,
      baseUrl,
      cardUrl,
      rpcUrl,
      token: env.UAB_A2A_AGENT_TOKEN,
      headers: parseRecord(env.UAB_A2A_AGENT_HEADERS_JSON),
      timeoutMs: parseNumber(env.UAB_A2A_TIMEOUT_MS),
      version: env.UAB_A2A_VERSION
    })
  ];
}

export class A2aAgentRegistry {
  private readonly agents = new Map<string, AgentBinding>();

  constructor(configs: A2aAgentConfig[]) {
    for (const config of configs.map(normalizeAgentConfig)) {
      if (this.agents.has(config.id)) {
        throw new Error(`Duplicate A2A agent id '${config.id}'.`);
      }
      this.agents.set(config.id, { config });
    }
  }

  defaultAgentId(): string | undefined {
    if (this.agents.size === 1) return [...this.agents.keys()][0];
    return undefined;
  }

  async listAgents(): Promise<JsonValue> {
    const agents = await Promise.all(
      [...this.agents.values()].map(async (binding) => ({
        ...redactAgentConfig(binding.config),
        card: await this.getAgentCard(binding.config.id).catch((error) => ({
          error: error instanceof Error ? error.message : String(error)
        }))
      }))
    );

    return toJsonValue({ agents });
  }

  async getAgentCard(agentId: string): Promise<JsonValue> {
    const binding = this.requireAgent(agentId);
    if (!binding.card) {
      binding.card = await fetchAgentCard(binding.config);
      binding.rpcUrl = selectRpcUrl(binding.config, binding.card);
    }
    return toJsonValue(binding.card);
  }

  async sendMessage(agentId: string, params: JsonObject): Promise<JsonValue> {
    return this.call(agentId, "SendMessage", params);
  }

  async call(agentId: string, method: string, params: JsonObject): Promise<JsonValue> {
    const binding = this.requireAgent(agentId);
    if (!binding.rpcUrl) {
      await this.getAgentCard(agentId).catch(() => undefined);
      binding.rpcUrl = binding.rpcUrl ?? selectRpcUrl(binding.config, binding.card);
    }

    const result = await callA2aJsonRpc(binding, method, params);
    return toJsonValue({
      agentId,
      method,
      result
    });
  }

  private requireAgent(agentId: string): AgentBinding {
    const binding = this.agents.get(agentId);
    if (!binding) {
      throw new AdapterError(`A2A agent '${agentId}' is not configured.`, {
        code: BRIDGE_ERROR_CODES.runtimeNotFound,
        data: { agentId }
      });
    }
    return binding;
  }
}

async function fetchAgentCard(config: A2aAgentConfig): Promise<JsonObject> {
  const cardUrl = config.cardUrl ?? buildUrl(config.baseUrl, "/.well-known/agent-card.json");
  if (!cardUrl) {
    throw new AdapterError(`A2A agent '${config.id}' needs cardUrl or baseUrl.`, {
      code: BRIDGE_ERROR_CODES.invalidParams
    });
  }

  const response = await fetchWithTimeout(cardUrl, {
    method: "GET",
    headers: buildHeaders(config)
  }, config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const data = await response.json().catch(() => undefined);
  if (!response.ok || !isJsonObject(data)) {
    throw new AdapterError(`Failed to fetch A2A Agent Card for '${config.id}'.`, {
      code: BRIDGE_ERROR_CODES.adapterUnavailable,
      data: toJsonValue(data)
    });
  }
  return data as JsonObject;
}

async function callA2aJsonRpc(
  binding: AgentBinding,
  method: string,
  params: JsonObject
): Promise<unknown> {
  const rpcUrl = binding.rpcUrl ?? binding.config.rpcUrl ?? binding.config.baseUrl;
  if (!rpcUrl) {
    throw new AdapterError(`A2A agent '${binding.config.id}' needs an RPC URL.`, {
      code: BRIDGE_ERROR_CODES.invalidParams
    });
  }

  const id = `a2a_${Date.now().toString(36)}`;
  const response = await fetchWithTimeout(rpcUrl, {
    method: "POST",
    headers: {
      ...buildHeaders(binding.config),
      "content-type": "application/json",
      "a2a-version": binding.config.version ?? DEFAULT_A2A_VERSION
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params
    })
  }, binding.config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const contentType = response.headers.get("content-type") ?? "";
  const rpcResponse = contentType.includes("text/event-stream")
    ? await readSseJsonRpcResponse(response, id)
    : await response.json().catch(() => undefined) as JsonRpcResponse | undefined;

  if (!response.ok || !rpcResponse) {
    throw new AdapterError(`A2A RPC '${method}' returned HTTP ${response.status}.`, {
      code: BRIDGE_ERROR_CODES.adapterUnavailable,
      data: toJsonValue(rpcResponse)
    });
  }

  if (rpcResponse.error) {
    throw new AdapterError(rpcResponse.error.message ?? "A2A RPC failed.", {
      code: rpcResponse.error.code ?? BRIDGE_ERROR_CODES.adapterUnavailable,
      data: toJsonValue(rpcResponse.error.data)
    });
  }

  return rpcResponse.result ?? null;
}

async function readSseJsonRpcResponse(response: Response, id: string): Promise<JsonRpcResponse | undefined> {
  const text = await response.text();
  const events = text
    .split("\n\n")
    .flatMap((chunk) => chunk.split("\n").filter((line) => line.startsWith("data:")))
    .map((line) => line.slice(5).trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonRpcResponse);
  return events.find((event) => event.id === id) ?? events.at(-1);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AdapterError(`A2A request failed: ${message}`, {
      code: message.includes("abort") ? BRIDGE_ERROR_CODES.timeout : BRIDGE_ERROR_CODES.adapterUnavailable
    });
  } finally {
    clearTimeout(timeout);
  }
}

function selectRpcUrl(config: A2aAgentConfig, card?: JsonObject): string | undefined {
  if (config.rpcUrl) return config.rpcUrl;

  const supportedInterfaces = card?.supportedInterfaces;
  if (Array.isArray(supportedInterfaces)) {
    const jsonRpc = supportedInterfaces.find((entry) =>
      isJsonObject(entry) &&
      typeof entry.url === "string" &&
      String(entry.protocolBinding ?? "").toLowerCase() === "jsonrpc"
    );
    if (isJsonObject(jsonRpc) && typeof jsonRpc.url === "string") return jsonRpc.url;
  }

  const url = card?.url;
  if (typeof url === "string") return url;
  return buildUrl(config.baseUrl, "/rpc") ?? config.baseUrl;
}

function buildSendMessageParams(params: JsonObject): JsonObject {
  const existing = params.message;
  if (isJsonObject(existing)) {
    return stripAgentId(params);
  }

  const text = readStringParam(params, "text");
  const message: JsonObject = {
    role: params.role ?? "ROLE_USER",
    parts: [
      {
        text
      }
    ],
    messageId: params.messageId ?? `msg_${Date.now().toString(36)}`
  };
  if (typeof params.contextId === "string") message.contextId = params.contextId;
  if (typeof params.taskId === "string") message.taskId = params.taskId;

  const result: JsonObject = {
    message
  };
  if (isJsonObject(params.configuration)) result.configuration = params.configuration as JsonObject;
  if (isJsonObject(params.metadata)) result.metadata = params.metadata as JsonObject;
  return result;
}

function stripAgentId(params: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(params).filter(([key]) => key !== "agentId")
  ) as JsonObject;
}

function normalizeAgentConfig(config: A2aAgentConfig): A2aAgentConfig {
  if (!config.id || !config.id.trim()) {
    throw new Error("A2A agent id is required.");
  }
  if (!config.baseUrl && !config.cardUrl && !config.rpcUrl) {
    throw new Error(`A2A agent '${config.id}' requires baseUrl, cardUrl, or rpcUrl.`);
  }
  return {
    ...config,
    id: config.id.trim(),
    name: config.name?.trim() || config.id.trim(),
    baseUrl: trimTrailingSlash(config.baseUrl),
    cardUrl: config.cardUrl,
    rpcUrl: config.rpcUrl,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    version: config.version ?? DEFAULT_A2A_VERSION
  };
}

function redactAgentConfig(config: A2aAgentConfig): JsonObject {
  return {
    id: config.id,
    name: config.name ?? config.id,
    baseUrl: config.baseUrl ?? null,
    cardUrl: config.cardUrl ?? null,
    rpcUrl: config.rpcUrl ?? null,
    version: config.version ?? DEFAULT_A2A_VERSION,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    headerKeys: config.headers ? Object.keys(config.headers) : [],
    hasToken: Boolean(config.token)
  };
}

function buildHeaders(config: A2aAgentConfig): Record<string, string> {
  return {
    accept: "application/json, application/a2a+json, text/event-stream",
    ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
    ...config.headers
  };
}

function buildUrl(baseUrl: string | undefined, path: string): string | undefined {
  if (!baseUrl) return undefined;
  return `${trimTrailingSlash(baseUrl)}${path.startsWith("/") ? path : `/${path}`}`;
}

function trimTrailingSlash(value: string | undefined): string | undefined {
  return value?.replace(/\/+$/, "");
}

function readObjectParams(params: unknown, optional = false): JsonObject {
  if ((params === undefined || params === null) && optional) return {};
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
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  throw new AdapterError(`Parameter '${key}' is required.`, {
    code: BRIDGE_ERROR_CODES.invalidParams
  });
}

function readAgentId(params: unknown, fallback?: string): string {
  if (!isJsonObject(params)) {
    if (fallback) return fallback;
    throw new AdapterError("Parameter 'agentId' is required.", {
      code: BRIDGE_ERROR_CODES.invalidParams
    });
  }
  return readStringParam(params as JsonObject, "agentId", fallback);
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

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
