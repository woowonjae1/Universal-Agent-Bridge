import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
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

export interface PiAdapterOptions {
  id?: string;
  name?: string;
  piPath?: string;
  command?: string;
  args?: string[];
  timeoutMs?: number;
}

interface PiProcessInstance {
  child: ChildProcess;
  pendingCommands: Map<string, {
    resolve: (res: any) => void;
    reject: (err: Error) => void;
  }>;
  eventListeners: Set<(event: any) => void>;
}

const CAPABILITIES: RuntimeCapabilities = {
  system: { read: true, methods: ["health", "status", "get_state"] },
  agent: { read: true, write: true, methods: ["agent", "agent.stream", "abort"] },
  session: { read: true, write: true, methods: ["new_session", "switch_session", "get_session_stats", "get_entries"] },
  messages: { read: true, methods: ["get_messages", "get_last_assistant_text"] }
};

const DEFAULT_METHODS: RuntimeMethodDefinition[] = [
  {
    name: "health",
    title: "Health",
    description: "Read Pi agent health.",
    capability: "system",
    risk: "read",
    paramsExample: {}
  },
  {
    name: "status",
    title: "Status",
    description: "Read Pi agent status summary.",
    capability: "system",
    risk: "read",
    paramsExample: {}
  },
  {
    name: "agent",
    title: "Agent Run",
    description: "Start a Pi agent request.",
    capability: "agent",
    risk: "write",
    paramsExample: { message: "List files in src", sessionKey: "default" },
    paramsSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "向 Pi 智能体发送的编程或系统操作指令" },
        sessionKey: { type: "string", description: "会话标识，切换不同的上下文" }
      },
      required: ["message"]
    }
  },
  {
    name: "agent.stream",
    title: "Stream Agent Run",
    description: "Start a Pi agent request and stream events.",
    capability: "agent",
    risk: "write",
    paramsExample: { message: "List files in src", sessionKey: "default" },
    paramsSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "向 Pi 智能体发送的指令，流式接收输出增量与工具执行" },
        sessionKey: { type: "string", description: "会话标识" }
      },
      required: ["message"]
    }
  }
];

export function createPiAdapter(options: PiAdapterOptions = {}): AgentRuntimeAdapter {
  const processes = new Map<string, PiProcessInstance>();

  function getOrCreateProcess(sessionId: string, context?: AdapterCallContext): PiProcessInstance {
    let instance = processes.get(sessionId);
    if (!instance || instance.child.killed || instance.child.exitCode !== null) {
      const piPath = options.piPath ?? "D:\\code\\pi\\pi_woowonjae";
      const command = options.command ?? "node";
      
      const defaultArgs = [
        "node_modules/tsx/dist/cli.mjs",
        "packages/coding-agent/src/cli.ts",
        "--mode", "rpc",
        "--session-id", sessionId
      ];
      const args = options.args ?? defaultArgs;

      context?.logger?.info?.(`Spawning Pi agent process: ${command} ${args.join(" ")} in ${piPath}`);
      
      const child = spawn(command, args, {
        cwd: piPath,
        shell: process.platform === "win32",
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env
        }
      });

      const pendingCommands = new Map<string, {
        resolve: (res: any) => void;
        reject: (err: Error) => void;
      }>();
      const eventListeners = new Set<(event: any) => void>();

      instance = { child, pendingCommands, eventListeners };
      processes.set(sessionId, instance);

      child.stderr?.on("data", (chunk) => {
        const msg = chunk.toString().trim();
        if (msg) {
          context?.logger?.warn?.(`Pi [${sessionId}] stderr: ${msg}`);
        }
      });

      const rl = createInterface({
        input: child.stdout!,
        terminal: false
      });

      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const obj = JSON.parse(trimmed);
          if (obj.type === "response" && obj.id && pendingCommands.has(obj.id)) {
            const { resolve, reject } = pendingCommands.get(obj.id)!;
            pendingCommands.delete(obj.id);
            if (obj.success === false) {
              reject(new Error(obj.error || "RPC command failed"));
            } else {
              resolve(obj.data ?? obj);
            }
          } else {
            for (const listener of eventListeners) {
              listener(obj);
            }
          }
        } catch (err) {
          context?.logger?.debug?.(`Failed to parse line from Pi [${sessionId}] stdout: ${line}`, err);
        }
      });

      child.on("error", (error) => {
        context?.logger?.error?.(`Pi agent [${sessionId}] process error: ${error.message}`);
        processes.delete(sessionId);
        for (const [_, { reject }] of pendingCommands) {
          reject(error);
        }
      });

      child.on("close", (code) => {
        context?.logger?.info?.(`Pi agent [${sessionId}] process closed with code ${code}`);
        processes.delete(sessionId);
        for (const [_, { reject }] of pendingCommands) {
          reject(new Error(`Pi process closed with code ${code}`));
        }
      });
    }
    return instance;
  }

  async function sendCommand(
    sessionId: string,
    command: Record<string, any>,
    context?: AdapterCallContext
  ): Promise<any> {
    const instance = getOrCreateProcess(sessionId, context);
    const id = `cmd_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    const fullCommand = { id, ...command };

    return new Promise((resolve, reject) => {
      instance.pendingCommands.set(id, { resolve, reject });
      instance.child.stdin?.write(JSON.stringify(fullCommand) + "\n");
    });
  }

  async function* streamPi(
    request: AdapterCallRequest,
    context: AdapterCallContext
  ): AsyncIterable<AdapterStreamEvent> {
    const params = isJsonObject(request.params) ? request.params as JsonObject : {};
    const message = typeof params.message === "string" ? params.message : "";
    const sessionId = typeof params.sessionKey === "string" ? params.sessionKey : (context.session?.id ?? "default");

    const instance = getOrCreateProcess(sessionId, context);
    const queue = createAsyncQueue<AdapterStreamEvent>();

    const listener = (event: any) => {
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        queue.push({
          type: "text",
          delta: event.assistantMessageEvent.delta
        });
      } else if (event.type === "tool_execution_start") {
        queue.push({
          type: "tool_call",
          name: event.toolName,
          data: event.args
        });
      } else if (event.type === "agent_end" && event.willRetry === false) {
        sendCommand(sessionId, { type: "get_last_assistant_text" }, context)
          .then((res) => {
            const text = res?.text ?? "";
            queue.push({
              type: "result",
              data: text
            });
            queue.end();
          })
          .catch((err) => {
            queue.fail(err);
          });
      }
    };

    instance.eventListeners.add(listener);

    const onAbort = () => {
      sendCommand(sessionId, { type: "abort" }, context).catch(() => {});
    };
    
    if (context.signal?.aborted) {
      onAbort();
    } else {
      context.signal?.addEventListener("abort", onAbort, { once: true });
    }

    try {
      await sendCommand(sessionId, { type: "prompt", message }, context);
      for await (const streamEvent of queue) {
        yield streamEvent;
      }
    } finally {
      instance.eventListeners.delete(listener);
      context.signal?.removeEventListener("abort", onAbort);
    }
  }

  return {
    info: {
      id: options.id ?? "pi",
      name: options.name ?? "Pi Coding Agent",
      description: `Pi Coding Agent adapter at ${options.piPath ?? "D:\\code\\pi\\pi_woowonjae"}`
    },
    capabilities() {
      return CAPABILITIES;
    },
    methods() {
      return DEFAULT_METHODS;
    },
    async health(): Promise<AdapterHealth> {
      try {
        const state = await sendCommand("default", { type: "get_state" });
        return {
          status: "ok",
          details: state
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
      const params = isJsonObject(request.params) ? request.params as JsonObject : {};
      const sessionId = typeof params.sessionKey === "string" ? params.sessionKey : (context.session?.id ?? "default");

      if (request.method === "agent") {
        let resultText = "";
        for await (const event of streamPi(request, context)) {
          if (event.type === "text") {
            resultText += event.delta;
          } else if (event.type === "result") {
            return event.data;
          } else if (event.type === "error") {
            const errorCode = typeof event.code === "number" ? event.code : (typeof event.code === "string" ? parseInt(event.code, 10) : undefined);
            throw new AdapterError(event.message, { code: Number.isInteger(errorCode) ? errorCode : undefined });
          }
        }
        return resultText;
      }

      let commandType = request.method;
      if (request.method === "status") {
        commandType = "get_state";
      }

      return sendCommand(sessionId, { type: commandType, ...params }, context);
    },
    stream(request, context) {
      return streamPi(request, context);
    },
    stop() {
      for (const [_, instance] of processes) {
        try {
          instance.child.kill();
        } catch {
          // ignore
        }
      }
      processes.clear();
    }
  };
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
