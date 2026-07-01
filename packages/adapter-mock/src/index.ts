import { AdapterError, type AgentRuntimeAdapter, type RuntimeCapabilities } from "@uab/adapter-sdk";
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

