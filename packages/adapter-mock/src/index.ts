import {
  AdapterError,
  type AgentRuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeMethodDefinition
} from "@uab/adapter-sdk";
import { BRIDGE_ERROR_CODES, isJsonObject } from "@uab/protocol";

interface MockSession {
  id: string;
  title: string;
  updatedAt: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface MockAdapterOptions {
  runtimeId?: string;
  runtimeName?: string;
}

export function createMockAdapter(options: MockAdapterOptions = {}): AgentRuntimeAdapter {
  const runtimeId = options.runtimeId ?? "mock";
  const runtimeName = options.runtimeName ?? "Mock Agent Runtime";
  const sessions: MockSession[] = [
    {
      id: "session_demo",
      title: "Demo session",
      updatedAt: new Date(0).toISOString(),
      messages: [
        { role: "user", content: "Hello bridge" },
        { role: "assistant", content: "Hello from the mock runtime" }
      ]
    }
  ];
  let currentModel = "mock-fast";

  const capabilities: RuntimeCapabilities = {
    system: { read: true },
    sessions: { read: true, write: true },
    models: { read: true, write: true },
    memory: { read: true },
    artifacts: { read: true },
    skills: { read: true },
    cron: { read: true }
  };
  const methods: RuntimeMethodDefinition[] = [
    {
      name: "system.ping",
      title: "Ping runtime",
      description: "Check whether the runtime can receive and answer bridge calls.",
      capability: "system",
      risk: "read",
      paramsExample: { message: "hello" }
    },
    {
      name: "system.health",
      title: "Runtime health",
      description: "Return lightweight runtime health information.",
      capability: "system",
      risk: "read",
      paramsExample: {}
    },
    {
      name: "runtime.capabilities",
      title: "List capabilities",
      description: "Return the runtime capability descriptor.",
      capability: "runtime",
      risk: "read",
      paramsExample: {}
    },
    {
      name: "sessions.list",
      title: "List sessions",
      description: "List available sessions with compact metadata.",
      capability: "sessions",
      risk: "read",
      paramsExample: {}
    },
    {
      name: "sessions.get",
      title: "Get session",
      description: "Read one session with messages.",
      capability: "sessions",
      risk: "read",
      paramsExample: { id: "session_demo" }
    },
    {
      name: "sessions.create",
      title: "Create session",
      description: "Create a new in-memory mock session.",
      capability: "sessions",
      risk: "write",
      paramsExample: { title: "New session" }
    },
    {
      name: "models.list",
      title: "List models",
      description: "List mock model options and the currently selected model.",
      capability: "models",
      risk: "read",
      paramsExample: {}
    },
    {
      name: "models.set",
      title: "Set model",
      description: "Switch the active mock model.",
      capability: "models",
      risk: "write",
      paramsExample: { model: "mock-balanced" }
    },
    {
      name: "memory.listFiles",
      title: "List memory files",
      description: "List memory files known to the runtime.",
      capability: "memory",
      risk: "read",
      paramsExample: {}
    },
    {
      name: "artifacts.list",
      title: "List artifacts",
      description: "List runtime artifacts.",
      capability: "artifacts",
      risk: "read",
      paramsExample: {}
    },
    {
      name: "skills.listInstalled",
      title: "List skills",
      description: "List installed skills for the runtime.",
      capability: "skills",
      risk: "read",
      paramsExample: {}
    },
    {
      name: "cron.list",
      title: "List cron jobs",
      description: "List scheduled jobs exposed by the runtime.",
      capability: "cron",
      risk: "read",
      paramsExample: {}
    }
  ];

  return {
    info: {
      id: runtimeId,
      name: runtimeName,
      version: "0.1.0",
      description: "In-memory runtime used for local development and demos."
    },
    capabilities() {
      return capabilities;
    },
    methods() {
      return methods;
    },
    health() {
      return {
        status: "ok",
        details: {
          sessions: sessions.length,
          model: currentModel
        }
      };
    },
    call(request) {
      switch (request.method) {
        case "system.ping":
          return {
            ok: true,
            runtime: runtimeId,
            timestamp: new Date().toISOString(),
            echo: request.params ?? null
          };
        case "system.health":
          return {
            status: "ok",
            runtime: runtimeId
          };
        case "runtime.capabilities":
          return capabilities;
        case "sessions.list":
          return {
            sessions: sessions.map(({ messages, ...session }) => ({
              ...session,
              messageCount: messages.length
            }))
          };
        case "sessions.get": {
          const id = readStringParam(request.params, "id");
          const session = sessions.find((entry) => entry.id === id);
          if (!session) {
            throw new AdapterError(`Session '${id}' was not found.`, {
              code: BRIDGE_ERROR_CODES.methodNotFound
            });
          }
          return session;
        }
        case "sessions.create": {
          const title = readStringParam(request.params, "title", "Untitled session");
          const session: MockSession = {
            id: `session_${sessions.length + 1}`,
            title,
            updatedAt: new Date().toISOString(),
            messages: []
          };
          sessions.push(session);
          return session;
        }
        case "models.list":
          return {
            current: currentModel,
            models: ["mock-fast", "mock-balanced", "mock-deep"]
          };
        case "models.set": {
          currentModel = readStringParam(request.params, "model");
          return {
            current: currentModel
          };
        }
        case "memory.listFiles":
          return {
            files: [
              { path: "memory/project.md", sizeBytes: 128 },
              { path: "memory/preferences.md", sizeBytes: 64 }
            ]
          };
        case "artifacts.list":
          return {
            artifacts: []
          };
        case "skills.listInstalled":
          return {
            skills: []
          };
        case "cron.list":
          return {
            jobs: []
          };
        default:
          throw new AdapterError(`Method '${request.method}' is not supported by mock runtime.`, {
            code: BRIDGE_ERROR_CODES.methodNotFound,
            data: { method: request.method }
          });
      }
    }
  };
}

function readStringParam(params: unknown, key: string, fallback?: string): string {
  if (!isJsonObject(params)) {
    if (fallback !== undefined) return fallback;
    throw new AdapterError(`Parameter '${key}' is required.`, {
      code: BRIDGE_ERROR_CODES.invalidParams
    });
  }

  const value = params[key];
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }

  if (fallback !== undefined) return fallback;

  throw new AdapterError(`Parameter '${key}' is required.`, {
    code: BRIDGE_ERROR_CODES.invalidParams
  });
}
