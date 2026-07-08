import { spawn } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signPayload
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  AdapterError,
  type AdapterCallContext,
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
  deviceToken?: string;
  deviceIdentity?: OpenClawDeviceIdentityOptions;
  deviceAuthStorePath?: string;
  connectChallengeTimeoutMs?: number;
  role?: string;
  clientId?: string;
  deviceFamily?: string;
  scopes?: string[];
  timeoutMs?: number;
  mode?: "gateway" | "cli";
  cliCommand?: string;
}

export interface OpenClawDeviceIdentityOptions {
  deviceId?: string;
  publicKeyPem?: string;
  privateKeyPem: string;
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

interface OpenClawDeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

interface OpenClawConnectAssembly {
  params: JsonObject;
  identity?: OpenClawDeviceIdentity;
  role: string;
}

interface OpenClawStoredDeviceAuth {
  token: string;
  scopes?: string[];
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

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
    paramsExample: { message: "Summarize this workspace", sessionKey: "default" },
    paramsSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "发送给智能体的消息内容" },
        sessionKey: { type: "string", description: "会话标识" }
      },
      required: ["message"]
    }
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
    paramsExample: { message: "Summarize this workspace", sessionKey: "default" },
    paramsSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "发送给智能体的消息内容，采用流式增量回复" },
        sessionKey: { type: "string", description: "会话标识" }
      },
      required: ["message"]
    }
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
    paramsExample: { sessionKey: "session-key", message: "Hello" }
  },
  {
    name: "chat.stream",
    title: "Chat Stream",
    description: "Send a chat message and forward OpenClaw Gateway events.",
    capability: "chat",
    risk: "write",
    paramsExample: { sessionKey: "session-key", message: "Hello" }
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
    paramsExample: { sessionKey: "session-key" }
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
    async call(request, context) {
      if (request.method === "gateway.call") {
        const params = readObjectParams(request.params);
        const method = readStringParam(params, "method");
        return callOpenClaw(method, params.params ?? {}, options, timeoutMs, context.signal);
      }

      const method = mapOpenClawStandardMethod(request.method);
      return callOpenClaw(
        method,
        normalizeOpenClawStandardParams(method, request.params ?? {}, request, context),
        options,
        timeoutMs,
        context.signal
      );
    },
    stream(request, context) {
      return streamOpenClaw(request, context, options, timeoutMs);
    }
  };
}

async function* streamOpenClaw(
  request: AdapterCallRequest,
  context: AdapterCallContext,
  options: OpenClawAdapterOptions,
  timeoutMs: number
): AsyncIterable<AdapterStreamEvent> {
  const method = mapOpenClawStandardMethod(request.method);
  const params = normalizeOpenClawStandardParams(method, request.params ?? {}, request, context);
  // The gateway echoes the same turn on both the `chat` and `agent` event
  // channels. Consume only the one matching the requested method so tokens
  // are not counted twice.
  const primaryChannel = openClawPrimaryChannel(request.method);

  if (options.mode === "cli") {
    const result = await callOpenClawCli(
      method,
      params,
      options,
      timeoutMs,
      context.signal
    );
    yield {
      type: "result",
      data: toJsonValue(result)
    };
    return;
  }

  const queue = createAsyncQueue<AdapterStreamEvent>();
  void callOpenClawGatewayWithEvents(method, params, options, timeoutMs, context.signal, (event) => {
    if (openClawEventIsOtherChannel(event, primaryChannel)) return;
    queue.push(openClawEventToStreamEvent(event));
  }, true, primaryChannel).then((result) => {
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
  timeoutMs: number,
  signal?: AbortSignal
): Promise<unknown> {
  if (options.mode === "cli") {
    return callOpenClawCli(method, params, options, timeoutMs, signal);
  }

  return callOpenClawGateway(method, params, options, timeoutMs, signal);
}

function normalizeOpenClawStandardParams(
  method: string,
  params: unknown,
  request?: AdapterCallRequest,
  context?: AdapterCallContext
): unknown {
  if (method === "chat.send") {
    return normalizeOpenClawChatSendParams(params, request, context);
  }
  if (method === "agent" || method === "agent.stream") {
    return normalizeOpenClawAgentParams(params, request, context);
  }
  if (method === "artifacts.list") {
    return normalizeOpenClawArtifactsListParams(params, request, context);
  }
  return params;
}

function normalizeOpenClawChatSendParams(
  params: unknown,
  request?: AdapterCallRequest,
  context?: AdapterCallContext
): JsonObject {
  const object = isJsonObject(params) ? params as JsonObject : {};
  const message = readOpenClawMessageText(params, object);
  const sessionKey = readOpenClawSessionKey(object, request, context);
  const idempotencyKey = readOpenClawIdempotencyKey(object, request, context);

  const output: JsonObject = {};
  copyKnownJsonField(object, output, "agentId");
  copyKnownJsonField(object, output, "sessionId");
  copyKnownJsonField(object, output, "__controlUiReconnectResume");
  copyKnownJsonField(object, output, "attachments");

  output.sessionKey = sessionKey;
  if (message !== undefined) output.message = message;
  output.deliver = typeof object.deliver === "boolean" ? object.deliver : false;
  if (idempotencyKey) output.idempotencyKey = idempotencyKey;
  return output;
}

function normalizeOpenClawAgentParams(
  params: unknown,
  request?: AdapterCallRequest,
  context?: AdapterCallContext
): JsonObject {
  const object = isJsonObject(params) ? params as JsonObject : {};
  const message = readOpenClawMessageText(params, object);
  const idempotencyKey = readOpenClawIdempotencyKey(object, request, context);
  const output: JsonObject = {};
  copyKnownJsonField(object, output, "agentId");
  copyKnownJsonField(object, output, "sessionId");
  copyKnownJsonField(object, output, "attachments");
  output.sessionKey = readOpenClawSessionKey(object, request, context);
  if (message !== undefined) output.message = message;
  if (idempotencyKey) output.idempotencyKey = idempotencyKey;
  return output;
}

function normalizeOpenClawArtifactsListParams(
  params: unknown,
  request?: AdapterCallRequest,
  context?: AdapterCallContext
): JsonObject {
  const object = isJsonObject(params) ? params as JsonObject : {};
  const output: JsonObject = {
    sessionKey: readOpenClawSessionKey(object, request, context)
  };
  copyKnownJsonField(object, output, "agentId");
  copyKnownJsonField(object, output, "sessionId");
  copyKnownJsonField(object, output, "runId");
  copyKnownJsonField(object, output, "taskId");
  return output;
}

function readOpenClawMessageText(params: unknown, object: JsonObject): string | undefined {
  return normalizeNonEmptyString(object.message)
    ?? normalizeNonEmptyString(object.text)
    ?? normalizeNonEmptyString(object.prompt)
    ?? normalizeNonEmptyString(object.input)
    ?? normalizeNonEmptyString(object.content)
    ?? (typeof params === "string" ? normalizeNonEmptyString(params) : undefined)
    ?? (object.message === undefined ? undefined : JSON.stringify(object.message));
}

function readOpenClawSessionKey(
  params: JsonObject,
  request?: AdapterCallRequest,
  context?: AdapterCallContext
): string {
  return normalizeNonEmptyString(params.sessionKey)
    ?? normalizeNonEmptyString(params.session_key)
    ?? normalizeNonEmptyString(request?.raw.session?.id)
    ?? normalizeNonEmptyString(context?.session?.id)
    ?? "default";
}

function readOpenClawIdempotencyKey(
  params: JsonObject,
  request?: AdapterCallRequest,
  context?: AdapterCallContext
): string | undefined {
  return normalizeNonEmptyString(params.idempotencyKey)
    ?? normalizeNonEmptyString(params.idempotency_key)
    ?? normalizeNonEmptyString(params.runId)
    ?? normalizeNonEmptyString(params.run_id)
    ?? readIdLike(request?.raw.id)
    ?? readIdLike(context?.requestId);
}

function copyKnownJsonField(input: JsonObject, output: JsonObject, key: string): void {
  if (input[key] !== undefined) output[key] = input[key];
}

function readIdLike(value: unknown): string | undefined {
  const text = normalizeNonEmptyString(value);
  if (text) return text;
  return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}

async function callOpenClawGateway(
  method: string,
  params: unknown,
  options: OpenClawAdapterOptions,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<unknown> {
  const result = await callOpenClawGatewayWithEvents(method, params, options, timeoutMs, signal);
  return result.payload;
}

async function callOpenClawGatewayWithEvents(
  method: string,
  params: unknown,
  options: OpenClawAdapterOptions,
  timeoutMs: number,
  signal?: AbortSignal,
  onEvent?: (event: OpenClawGatewayEvent) => void,
  streaming?: boolean,
  primaryChannel?: "chat" | "agent"
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
  let connectChallengeNonce: string | undefined;
  let resolveChallenge: ((nonce: string | undefined) => void) | undefined;
  let rejectChallenge: ((error: Error) => void) | undefined;
  let rejectOpen: ((error: Error) => void) | undefined;

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

  const failPending = (error: AdapterError) => {
    rejectOpen?.(error);
    rejectOpen = undefined;
    rejectChallenge?.(error);
    resolveChallenge = undefined;
    rejectChallenge = undefined;
    for (const entry of pending.values()) {
      entry.reject(error);
    }
    pending.clear();
  };

  const waitForOpen = new Promise<void>((resolve, reject) => {
    rejectOpen = reject;
    socket.addEventListener("open", () => {
      rejectOpen = undefined;
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => reject(new Error("OpenClaw Gateway WebSocket failed to open.")));
    socket.addEventListener("close", () => {
      if (!connected) reject(new Error("OpenClaw Gateway WebSocket closed before connect."));
    });
  });
  waitForOpen.catch(() => undefined);

  const waitForConnectChallenge = new Promise<string | undefined>((resolve, reject) => {
    resolveChallenge = resolve;
    rejectChallenge = reject;
  });
  waitForConnectChallenge.catch(() => undefined);

  socket.addEventListener("message", (event) => {
    const frame = parseGatewayFrame(event.data);
    if (!frame) return;

    if (frame.type === "event") {
      if (frame.event === "connect.challenge") {
        const nonce = readGatewayEventNonce(frame.payload);
        connectChallengeNonce = nonce;
        resolveChallenge?.(nonce);
        resolveChallenge = undefined;
        rejectChallenge = undefined;
        return;
      }

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
    failPending(new AdapterError("OpenClaw Gateway WebSocket closed.", {
      code: BRIDGE_ERROR_CODES.adapterUnavailable
    }));
  });

  const abortGateway = () => {
    failPending(new AdapterError("OpenClaw Gateway request aborted.", {
      code: BRIDGE_ERROR_CODES.timeout
    }));
    if (!closed) socket.close();
  };

  const timeout = setTimeout(() => {
    failPending(new AdapterError("OpenClaw Gateway request timed out.", {
      code: BRIDGE_ERROR_CODES.timeout
    }));
    if (!closed) socket.close();
  }, timeoutMs);

  try {
    if (signal?.aborted) abortGateway();
    signal?.addEventListener("abort", abortGateway, { once: true });
    await waitForOpen;
    const challengeNonce = options.deviceIdentity
      ? await Promise.race([
        connectChallengeNonce !== undefined ? Promise.resolve(connectChallengeNonce) : waitForConnectChallenge,
        delayReject(options.connectChallengeTimeoutMs ?? 5_000, "OpenClaw Gateway did not send a connect challenge.")
      ])
      : connectChallengeNonce;
    const connect = await buildOpenClawConnectParams(options, challengeNonce);
    const hello = await sendRequest("connect", connect.params);
    await storeOpenClawDeviceAuthFromHello(options, connect, hello);
    connected = true;
    const ackPayload = await sendRequest(method, params);
    if (streaming) {
      await collectStreamingEvents({
        runId: readPayloadString(toJsonValue(ackPayload), "runId"),
        primaryChannel,
        events,
        isClosed: () => closed,
        isAborted: () => Boolean(signal?.aborted),
        overallDeadline: Date.now() + timeoutMs
      });
    }
    return {
      payload: ackPayload,
      events
    };
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw new AdapterError(error instanceof Error ? error.message : String(error), {
      code: BRIDGE_ERROR_CODES.adapterUnavailable
    });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortGateway);
    if (!closed) socket.close();
  }
}

async function callOpenClawCli(
  method: string,
  params: unknown,
  options: OpenClawAdapterOptions,
  timeoutMs: number,
  signal?: AbortSignal
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
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const abortChild = (message: string) => {
      child.kill();
      settle(() => reject(new AdapterError(message, {
        code: BRIDGE_ERROR_CODES.timeout
      })));
    };
    const onAbort = () => abortChild("OpenClaw CLI request aborted.");
    const timeout = setTimeout(() => {
      abortChild("OpenClaw CLI request timed out.");
    }, timeoutMs);
    if (signal?.aborted) {
      abortChild("OpenClaw CLI request aborted.");
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      settle(() => reject(new AdapterError(`OpenClaw CLI failed: ${error.message}`, {
        code: BRIDGE_ERROR_CODES.adapterUnavailable
      })));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        settle(() => reject(new AdapterError(`OpenClaw CLI exited with code ${code}.`, {
          code: BRIDGE_ERROR_CODES.adapterUnavailable,
          data: { stderr: stderr.trim() }
        })));
        return;
      }

      settle(() => {
        try {
          resolve(JSON.parse(stdout) as JsonValue);
        } catch {
          resolve({ output: stdout.trim() });
        }
      });
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

async function buildOpenClawConnectParams(
  options: OpenClawAdapterOptions,
  nonce?: string
): Promise<OpenClawConnectAssembly> {
  const role = options.role ?? "operator";
  const clientId = options.clientId ?? "gateway-client";
  const clientMode = "backend";
  const platform = process.platform;
  const identity = options.deviceIdentity
    ? normalizeOpenClawDeviceIdentity(options.deviceIdentity)
    : undefined;
  const storedAuth = identity
    ? await loadOpenClawDeviceAuth(options.deviceAuthStorePath, identity.deviceId, role)
    : undefined;
  const token = normalizeNonEmptyString(options.token);
  const password = normalizeNonEmptyString(options.password);
  const explicitDeviceToken = normalizeNonEmptyString(options.deviceToken);
  const shouldUseStoredDeviceToken = !token && !password && !explicitDeviceToken && Boolean(storedAuth?.token);
  const deviceToken = explicitDeviceToken ?? (shouldUseStoredDeviceToken ? storedAuth?.token : undefined);
  const scopes = options.scopes
    ?? (shouldUseStoredDeviceToken && storedAuth?.scopes?.length ? storedAuth.scopes : undefined)
    ?? ["operator.read", "operator.write"];
  const auth = buildOpenClawAuth({
    token,
    password,
    deviceToken
  });
  const params: JsonObject = {
    minProtocol: 4,
    maxProtocol: 4,
    client: {
      id: clientId,
      version: "0.1.0",
      platform,
      ...(options.deviceFamily ? { deviceFamily: options.deviceFamily } : {}),
      mode: clientMode
    },
    role,
    scopes,
    caps: [],
    commands: [],
    permissions: {},
    ...(Object.keys(auth).length > 0 ? { auth } : {}),
    locale: "en-US",
    userAgent: "universal-agent-bridge/0.1.0"
  };

  if (identity) {
    const trimmedNonce = normalizeNonEmptyString(nonce);
    if (!trimmedNonce) {
      throw new AdapterError("OpenClaw Gateway device identity requires a connect challenge nonce.", {
        code: BRIDGE_ERROR_CODES.adapterUnavailable,
        data: {
          code: "DEVICE_AUTH_NONCE_REQUIRED",
          nextStep: "Retry against an OpenClaw Gateway that emits connect.challenge before connect."
        }
      });
    }

    const signedAtMs = Date.now();
    const signatureToken = token ?? deviceToken;
    params.device = {
      id: identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
      signature: signOpenClawDevicePayload(identity.privateKeyPem, buildOpenClawDeviceAuthPayloadV3({
        deviceId: identity.deviceId,
        clientId,
        clientMode,
        role,
        scopes,
        signedAtMs,
        token: signatureToken,
        nonce: trimmedNonce,
        platform,
        deviceFamily: options.deviceFamily
      })),
      signedAt: signedAtMs,
      nonce: trimmedNonce
    };
  }

  return {
    params,
    identity,
    role
  };
}

function buildOpenClawAuth(options: {
  token?: string;
  password?: string;
  deviceToken?: string;
}): JsonObject {
  const auth: JsonObject = {};
  if (options.token ?? options.deviceToken) auth.token = options.token ?? options.deviceToken ?? "";
  if (options.deviceToken) auth.deviceToken = options.deviceToken;
  if (options.password) auth.password = options.password;
  return auth;
}

function normalizeOpenClawDeviceIdentity(
  identity: OpenClawDeviceIdentityOptions
): OpenClawDeviceIdentity {
  const privateKeyPem = identity.privateKeyPem.trim();
  if (!privateKeyPem) {
    throw new AdapterError("OpenClaw devicePrivateKeyPem is empty.", {
      code: BRIDGE_ERROR_CODES.invalidParams
    });
  }

  const publicKeyPem = identity.publicKeyPem?.trim() || publicKeyPemFromPrivateKey(privateKeyPem);
  const deviceId = identity.deviceId?.trim() || fingerprintOpenClawPublicKey(publicKeyPem);
  return {
    deviceId,
    publicKeyPem,
    privateKeyPem
  };
}

function publicKeyPemFromPrivateKey(privateKeyPem: string): string {
  try {
    return createPublicKey(createPrivateKey(privateKeyPem)).export({
      type: "spki",
      format: "pem"
    }).toString();
  } catch (error) {
    throw new AdapterError("OpenClaw devicePrivateKeyPem must be a valid Ed25519 PKCS8 PEM private key.", {
      code: BRIDGE_ERROR_CODES.invalidParams,
      data: { message: error instanceof Error ? error.message : String(error) }
    });
  }
}

function fingerprintOpenClawPublicKey(publicKeyPem: string): string {
  return createHash("sha256").update(deriveOpenClawPublicKeyRaw(publicKeyPem)).digest("hex");
}

function publicKeyRawBase64UrlFromPem(publicKeyPem: string): string {
  return base64UrlEncode(deriveOpenClawPublicKeyRaw(publicKeyPem));
}

function deriveOpenClawPublicKeyRaw(publicKeyPem: string): Buffer {
  const spki = createPublicKey(publicKeyPem).export({
    type: "spki",
    format: "der"
  }) as Buffer;

  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32
    && spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }

  return spki;
}

function buildOpenClawDeviceAuthPayloadV3(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string;
  nonce: string;
  platform: string;
  deviceFamily?: string;
}): string {
  return [
    "v3",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAtMs),
    params.token ?? "",
    params.nonce,
    normalizeDeviceMetadataForAuth(params.platform),
    normalizeDeviceMetadataForAuth(params.deviceFamily)
  ].join("|");
}

function signOpenClawDevicePayload(privateKeyPem: string, payload: string): string {
  return base64UrlEncode(signPayload(null, Buffer.from(payload, "utf8"), createPrivateKey(privateKeyPem)));
}

function base64UrlEncode(value: Buffer): string {
  return value
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

function normalizeDeviceMetadataForAuth(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32));
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function readGatewayEventNonce(payload: unknown): string | undefined {
  if (!isJsonObject(payload)) return undefined;
  return normalizeNonEmptyString(payload.nonce);
}

function delayReject(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new AdapterError(message, {
        code: BRIDGE_ERROR_CODES.timeout
      }));
    }, ms);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const OPENCLAW_TERMINAL_STATUSES = new Set([
  "completed", "complete", "finished", "done", "succeeded", "success",
  "error", "failed", "cancelled", "canceled", "aborted", "stopped"
]);

function openClawPrimaryChannel(requestMethod: string): "chat" | "agent" | undefined {
  if (requestMethod.startsWith("chat")) return "chat";
  if (requestMethod.startsWith("agent")) return "agent";
  return undefined;
}

/**
 * True when this event belongs to the conversational channel we are NOT
 * consuming for this call (chat vs agent), so its duplicate tokens are dropped.
 */
function openClawEventIsOtherChannel(
  event: OpenClawGatewayEvent,
  primaryChannel: "chat" | "agent" | undefined
): boolean {
  if (!primaryChannel) return false;
  const name = event.event;
  if (name !== "chat" && name !== "agent") return false;
  return name !== primaryChannel;
}

function openClawEventRunId(event: OpenClawGatewayEvent): string | undefined {
  const payload = event.payload;
  if (!isJsonObject(payload)) return undefined;
  for (const key of ["runId", "run_id", "id", "taskId"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

function isOpenClawTerminalEvent(event: OpenClawGatewayEvent): boolean {
  const name = event.event.toLowerCase();
  // Ignore infrastructure heartbeats that are unrelated to a run turn.
  if (name === "health" || name === "tick" || name === "presence" || name.startsWith("channel")) return false;
  const payload = event.payload;
  if (isJsonObject(payload)) {
    // chat.stream: a `state:"final"` (or error/abort) frame ends the turn.
    if (typeof payload.state === "string") {
      const state = payload.state.toLowerCase();
      if (state === "final" || state === "completed" || state === "error" || state === "aborted" || state === "cancelled") {
        return true;
      }
    }
    // agent(.stream): the run ends with a `data.phase:"end"` frame.
    if (isJsonObject(payload.data) && typeof payload.data.phase === "string") {
      const phase = payload.data.phase.toLowerCase();
      if (phase === "end" || phase === "error" || phase === "aborted") return true;
    }
    const status = payload.status;
    if (typeof status === "string" && OPENCLAW_TERMINAL_STATUSES.has(status.toLowerCase())) return true;
    if (payload.done === true || payload.final === true) return true;
  }
  if (/(complete|finish|done|stopped|aborted|cancel|failed)/.test(name)) return true;
  return false;
}

/**
 * OpenClaw's agent/chat turns are asynchronous: the RPC returns a run handle
 * ({status:"accepted"|"started"}) and the actual token/text events arrive on the
 * session event stream afterward. For streaming calls we keep the socket open
 * after the ack and keep collecting events until a terminal event for our run,
 * an idle gap once text has started, or the overall deadline.
 */
async function collectStreamingEvents(ctx: {
  runId?: string;
  primaryChannel?: "chat" | "agent";
  events: OpenClawGatewayEvent[];
  isClosed: () => boolean;
  isAborted: () => boolean;
  overallDeadline: number;
}): Promise<void> {
  // Idle is measured from the last TEXT token, not the last event: the gateway
  // emits `health`/`tick` heartbeats continuously, so keying idle off any event
  // would never let the turn finish once the model stopped producing tokens.
  const idleMs = 2_500;
  const pollMs = 120;
  let cursor = ctx.events.length;
  let lastTextAt = 0;

  while (true) {
    if (ctx.isClosed() || ctx.isAborted()) return;
    if (Date.now() > ctx.overallDeadline) return;

    for (; cursor < ctx.events.length; cursor += 1) {
      const event = ctx.events[cursor];
      if (openClawEventIsOtherChannel(event, ctx.primaryChannel)) continue;
      const eventRunId = openClawEventRunId(event);
      // If both ids are known and differ, this event belongs to another run.
      if (ctx.runId && eventRunId && eventRunId !== ctx.runId) continue;
      if (extractOpenClawText(event.payload ?? null)) lastTextAt = Date.now();
      if (isOpenClawTerminalEvent(event)) return;
    }

    if (lastTextAt > 0 && Date.now() - lastTextAt > idleMs) return;
    await delay(pollMs);
  }
}

async function loadOpenClawDeviceAuth(
  storePath: string | undefined,
  deviceId: string,
  role: string
): Promise<OpenClawStoredDeviceAuth | undefined> {
  if (!storePath) return undefined;

  try {
    const parsed = JSON.parse(await readFile(storePath, "utf8")) as unknown;
    if (!isJsonObject(parsed) || parsed.version !== 1 || parsed.deviceId !== deviceId) return undefined;
    const tokens = parsed.tokens;
    if (!isJsonObject(tokens)) return undefined;
    const entry = tokens[role];
    if (!isJsonObject(entry) || typeof entry.token !== "string" || entry.token.trim() === "") return undefined;
    return {
      token: entry.token,
      scopes: readStringArray(entry.scopes)
    };
  } catch {
    return undefined;
  }
}

async function storeOpenClawDeviceAuthFromHello(
  options: OpenClawAdapterOptions,
  connect: OpenClawConnectAssembly,
  hello: unknown
): Promise<void> {
  if (!options.deviceAuthStorePath || !connect.identity || !isJsonObject(hello)) return;
  const authInfo = hello.auth;
  if (!isJsonObject(authInfo) || typeof authInfo.deviceToken !== "string" || authInfo.deviceToken.trim() === "") {
    return;
  }

  const role = typeof authInfo.role === "string" && authInfo.role.trim() !== "" ? authInfo.role.trim() : connect.role;
  const scopes = readStringArray(authInfo.scopes) ?? [];

  let tokens: JsonObject = {};
  try {
    const parsed = JSON.parse(await readFile(options.deviceAuthStorePath, "utf8")) as unknown;
    if (isJsonObject(parsed) && parsed.version === 1 && parsed.deviceId === connect.identity.deviceId && isJsonObject(parsed.tokens)) {
      tokens = toJsonValue(parsed.tokens) as JsonObject;
    }
  } catch {
    tokens = {};
  }

  tokens[role] = {
    token: authInfo.deviceToken,
    role,
    scopes,
    updatedAtMs: Date.now()
  };

  await mkdir(dirname(options.deviceAuthStorePath), { recursive: true });
  await writeFile(options.deviceAuthStorePath, JSON.stringify({
    version: 1,
    deviceId: connect.identity.deviceId,
    tokens
  }, null, 2) + "\n", "utf8");
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    .map((entry) => entry.trim());
  return entries.length > 0 ? entries : undefined;
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
    const data = enrichOpenClawGatewayErrorData(toJsonValue(error) as JsonObject);
    return new AdapterError(message, {
      code: typeof error.code === "number" ? error.code : mapOpenClawStringErrorCode(error.code),
      data
    });
  }

  return new AdapterError("OpenClaw Gateway returned an error.", {
    code: BRIDGE_ERROR_CODES.adapterUnavailable
  });
}

function mapOpenClawStringErrorCode(code: unknown): number {
  switch (code) {
    case "INVALID_REQUEST": return BRIDGE_ERROR_CODES.invalidRequest;
    case "INVALID_PARAMS": return BRIDGE_ERROR_CODES.invalidParams;
    case "METHOD_NOT_FOUND": return BRIDGE_ERROR_CODES.methodNotFound;
    case "PERMISSION_DENIED": return BRIDGE_ERROR_CODES.permissionDenied;
    case "PARSE_ERROR": return BRIDGE_ERROR_CODES.parseError;
    default: return BRIDGE_ERROR_CODES.adapterUnavailable;
  }
}

function enrichOpenClawGatewayErrorData(error: JsonObject): JsonValue {
  const details = isJsonObject(error.details) ? error.details : undefined;
  const detailCode = typeof details?.code === "string" ? details.code : undefined;
  const requestId = typeof details?.requestId === "string" && details.requestId.trim() !== ""
    ? details.requestId.trim()
    : undefined;

  if (detailCode === "PAIRING_REQUIRED") {
    return {
      ...error,
      nextStep: requestId
        ? `Run: openclaw devices approve ${requestId}; then retry the UAB OpenClaw call.`
        : "Run: openclaw devices approve --latest, verify the request, approve the printed request id, then retry the UAB OpenClaw call."
    };
  }

  if (detailCode === "DEVICE_IDENTITY_REQUIRED" || detailCode === "CONTROL_UI_DEVICE_IDENTITY_REQUIRED") {
    return {
      ...error,
      nextStep: "Configure UAB_OPENCLAW_DEVICE_PRIVATE_KEY_PATH or UAB_OPENCLAW_DEVICE_PRIVATE_KEY_PEM so UAB can sign the OpenClaw Gateway connect request."
    };
  }

  return toJsonValue(error);
}

function mapOpenClawStandardMethod(method: string): string {
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

  // chat.stream delta events carry the incremental token in `deltaText`.
  if (typeof value.deltaText === "string" && value.deltaText.length > 0) return value.deltaText;

  // agent(.stream) events nest the increment under `data.delta` (data.text is
  // the cumulative buffer — using it would duplicate every token).
  if (isJsonObject(value.data) && typeof value.data.delta === "string" && value.data.delta.length > 0) {
    return value.data.delta;
  }

  for (const key of ["delta", "text", "content"]) {
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
