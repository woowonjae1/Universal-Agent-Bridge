#!/usr/bin/env node
import { createA2aAdapter, readA2aAgentConfigsFromEnv } from "@uab/a2a";
import { createHermesAdapter } from "@uab/adapter-hermes";
import { createHttpJsonRpcAdapter } from "@uab/adapter-http-jsonrpc";
import { createMockAdapter } from "@uab/adapter-mock";
import {
  createOpenClawAdapter,
  type OpenClawDeviceIdentityOptions
} from "@uab/adapter-openclaw";
import { AgentBridge } from "@uab/core";
import { createMcpAdapter, readMcpServerConfigsFromEnv } from "@uab/mcp";
import { createHttpBridgeServer, listen } from "@uab/transport-http";
import type { BridgeRequest } from "@uab/protocol";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

async function main(argv: string[]): Promise<void> {
  const [command = "help", ...args] = argv;

  switch (command) {
    case "demo":
      await runDemo();
      return;
    case "call":
      await runCall(args);
      return;
    case "serve":
      await runServe(args);
      return;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      console.error(`Unknown command '${command}'.`);
      printHelp();
      process.exitCode = 1;
  }
}

function createDemoBridge(): AgentBridge {
  const bridge = new AgentBridge();
  bridge.register(createMockAdapter());
  registerHttpRuntimeFromEnv(bridge);
  registerHermesRuntimeFromEnv(bridge);
  registerOpenClawRuntimeFromEnv(bridge);
  registerMcpRuntimeFromEnv(bridge);
  registerA2aRuntimeFromEnv(bridge);
  return bridge;
}

async function runDemo(): Promise<void> {
  const bridge = createDemoBridge();
  const requests: BridgeRequest[] = [
    {
      jsonrpc: "2.0",
      id: "demo_ping",
      runtime: "mock",
      method: "system.ping",
      params: { message: "hello" }
    },
    {
      jsonrpc: "2.0",
      id: "demo_sessions",
      runtime: "mock",
      method: "sessions.list",
      params: {}
    },
    {
      jsonrpc: "2.0",
      id: "demo_models",
      runtime: "mock",
      method: "models.list",
      params: {}
    }
  ];

  for (const request of requests) {
    const response = await bridge.handleRequest(request);
    console.log(JSON.stringify(response, null, 2));
  }
}

async function runCall(args: string[]): Promise<void> {
  const [runtime, method, paramsJson] = args;
  if (!runtime || !method) {
    throw new Error("Usage: uab call <runtime> <method> [jsonParams]");
  }

  const bridge = createDemoBridge();
  const request: BridgeRequest = {
    jsonrpc: "2.0",
    id: `cli_${Date.now().toString(36)}`,
    runtime,
    method,
    params: paramsJson ? JSON.parse(paramsJson) : {}
  };

  const response = await bridge.handleRequest(request);
  console.log(JSON.stringify(response, null, 2));
}

async function runServe(args: string[]): Promise<void> {
  const port = readNumberArg(args, "--port", 8787);
  const host = readStringArg(args, "--host", "127.0.0.1");
  const bridge = createDemoBridge();
  const server = createHttpBridgeServer({ bridge });

  await listen(server, { host, port });
  console.log(`Universal Agent Bridge listening on http://${host}:${port}`);
  console.log(`Registered runtimes: ${bridge.registry.list().map((adapter) => adapter.info.id).join(", ")}`);
}

function registerHttpRuntimeFromEnv(bridge: AgentBridge): void {
  const url = process.env.UAB_HTTP_RUNTIME_URL;
  if (!url) return;

  bridge.register(
    createHttpJsonRpcAdapter({
      id: process.env.UAB_HTTP_RUNTIME_ID ?? "external-http",
      name: process.env.UAB_HTTP_RUNTIME_NAME ?? "External HTTP Runtime",
      baseUrl: url,
      token: process.env.UAB_HTTP_RUNTIME_TOKEN,
      rpcPath: process.env.UAB_HTTP_RUNTIME_RPC_PATH,
      methodsPath: process.env.UAB_HTTP_RUNTIME_METHODS_PATH,
      capabilitiesPath: process.env.UAB_HTTP_RUNTIME_CAPABILITIES_PATH,
      healthPath: process.env.UAB_HTTP_RUNTIME_HEALTH_PATH,
      timeoutMs: readEnvNumber("UAB_HTTP_RUNTIME_TIMEOUT_MS", 15_000)
    })
  );
}

function registerHermesRuntimeFromEnv(bridge: AgentBridge): void {
  const url = process.env.UAB_HERMES_URL;
  if (!url) return;

  bridge.register(
    createHermesAdapter({
      id: process.env.UAB_HERMES_RUNTIME_ID ?? "hermes",
      name: process.env.UAB_HERMES_RUNTIME_NAME ?? "Hermes Agent",
      baseUrl: url,
      token: process.env.UAB_HERMES_TOKEN,
      model: process.env.UAB_HERMES_MODEL,
      timeoutMs: readEnvNumber("UAB_HERMES_TIMEOUT_MS", 30_000)
    })
  );
}

function registerOpenClawRuntimeFromEnv(bridge: AgentBridge): void {
  const gatewayUrl = process.env.UAB_OPENCLAW_GATEWAY_URL;
  const cliMode = process.env.UAB_OPENCLAW_MODE === "cli";
  if (!gatewayUrl && !cliMode) return;

  bridge.register(
    createOpenClawAdapter({
      id: process.env.UAB_OPENCLAW_RUNTIME_ID ?? "openclaw",
      name: process.env.UAB_OPENCLAW_RUNTIME_NAME ?? "OpenClaw",
      gatewayUrl,
      token: process.env.UAB_OPENCLAW_TOKEN,
      password: process.env.UAB_OPENCLAW_PASSWORD,
      deviceToken: process.env.UAB_OPENCLAW_DEVICE_TOKEN,
      deviceIdentity: readOpenClawDeviceIdentityFromEnv(process.env),
      deviceAuthStorePath: readOpenClawDeviceAuthStorePath(process.env),
      connectChallengeTimeoutMs: readEnvNumber("UAB_OPENCLAW_CONNECT_CHALLENGE_TIMEOUT_MS", 5_000),
      role: process.env.UAB_OPENCLAW_ROLE,
      clientId: process.env.UAB_OPENCLAW_CLIENT_ID,
      deviceFamily: process.env.UAB_OPENCLAW_DEVICE_FAMILY,
      mode: cliMode ? "cli" : "gateway",
      cliCommand: process.env.UAB_OPENCLAW_CLI,
      scopes: readCsvEnv("UAB_OPENCLAW_SCOPES"),
      timeoutMs: readEnvNumber("UAB_OPENCLAW_TIMEOUT_MS", 30_000)
    })
  );
}

function registerMcpRuntimeFromEnv(bridge: AgentBridge): void {
  const servers = readMcpServerConfigsFromEnv(process.env);
  if (servers.length === 0) return;

  bridge.register(
    createMcpAdapter({
      id: process.env.UAB_MCP_RUNTIME_ID ?? "mcp",
      name: process.env.UAB_MCP_RUNTIME_NAME ?? "MCP Tool Layer",
      servers
    })
  );
}

function registerA2aRuntimeFromEnv(bridge: AgentBridge): void {
  const agents = readA2aAgentConfigsFromEnv(process.env);
  if (agents.length === 0) return;

  bridge.register(
    createA2aAdapter({
      id: process.env.UAB_A2A_RUNTIME_ID ?? "a2a",
      name: process.env.UAB_A2A_RUNTIME_NAME ?? "A2A Agent Layer",
      agents
    })
  );
}

function readEnvNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readCsvEnv(name: string): string[] | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return entries.length > 0 ? entries : undefined;
}

function readOpenClawDeviceIdentityFromEnv(
  env: NodeJS.ProcessEnv
): OpenClawDeviceIdentityOptions | undefined {
  const explicitPrivateKey = readEnvTextOrFile(
    env.UAB_OPENCLAW_DEVICE_PRIVATE_KEY_PEM,
    env.UAB_OPENCLAW_DEVICE_PRIVATE_KEY_PATH
  );
  const explicitPublicKey = readEnvTextOrFile(
    env.UAB_OPENCLAW_DEVICE_PUBLIC_KEY_PEM,
    env.UAB_OPENCLAW_DEVICE_PUBLIC_KEY_PATH
  );

  if (explicitPrivateKey) {
    const explicitIdentity = parseOpenClawDeviceIdentityJson(explicitPrivateKey);
    if (explicitIdentity) {
      return {
        ...explicitIdentity,
        deviceId: env.UAB_OPENCLAW_DEVICE_ID ?? explicitIdentity.deviceId,
        publicKeyPem: explicitPublicKey ?? explicitIdentity.publicKeyPem
      };
    }

    return {
      deviceId: env.UAB_OPENCLAW_DEVICE_ID,
      publicKeyPem: explicitPublicKey,
      privateKeyPem: explicitPrivateKey
    };
  }

  if (env.UAB_OPENCLAW_AUTO_DEVICE_IDENTITY === "0") return undefined;

  const identityPath = env.UAB_OPENCLAW_DEVICE_IDENTITY_PATH
    ? resolveUserPath(env.UAB_OPENCLAW_DEVICE_IDENTITY_PATH, env)
    : join(resolveOpenClawStateDir(env), "identity", "device.json");

  try {
    if (!existsSync(identityPath)) return undefined;
    const parsed = JSON.parse(readFileSync(identityPath, "utf8")) as unknown;
    return normalizeOpenClawDeviceIdentityJson(parsed);
  } catch {
    return undefined;
  }
}

function readOpenClawDeviceAuthStorePath(env: NodeJS.ProcessEnv): string | undefined {
  if (env.UAB_OPENCLAW_DEVICE_AUTH_PATH) {
    return resolveUserPath(env.UAB_OPENCLAW_DEVICE_AUTH_PATH, env);
  }
  if (env.UAB_OPENCLAW_AUTO_DEVICE_AUTH === "0") return undefined;
  return join(resolveOpenClawStateDir(env), "identity", "device-auth.json");
}

function readEnvTextOrFile(value: string | undefined, filePath: string | undefined): string | undefined {
  if (value && value.trim() !== "") return value.trim();
  if (!filePath || filePath.trim() === "") return undefined;
  try {
    return readFileSync(resolveUserPath(filePath, process.env), "utf8").trim();
  } catch {
    return undefined;
  }
}

function parseOpenClawDeviceIdentityJson(text: string): OpenClawDeviceIdentityOptions | undefined {
  try {
    return normalizeOpenClawDeviceIdentityJson(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

function normalizeOpenClawDeviceIdentityJson(value: unknown): OpenClawDeviceIdentityOptions | undefined {
  if (!isRecord(value) || typeof value.privateKeyPem !== "string") return undefined;
  return {
    deviceId: typeof value.deviceId === "string" ? value.deviceId : undefined,
    publicKeyPem: typeof value.publicKeyPem === "string" ? value.publicKeyPem : undefined,
    privateKeyPem: value.privateKeyPem
  };
}

function resolveOpenClawStateDir(env: NodeJS.ProcessEnv): string {
  if (env.OPENCLAW_STATE_DIR && env.OPENCLAW_STATE_DIR.trim() !== "") {
    return resolveUserPath(env.OPENCLAW_STATE_DIR, env);
  }
  return join(homedir(), ".openclaw");
}

function resolveUserPath(value: string, env: NodeJS.ProcessEnv): string {
  const trimmed = value.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return join(homedir(), trimmed.slice(2));
  }
  const withEnv = trimmed.replace(/\$([A-Z_][A-Z0-9_]*)/gi, (_match, name: string) => env[name] ?? "");
  return resolve(withEnv);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readStringArg(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

function readNumberArg(args: string[], name: string, fallback: number): number {
  const value = readStringArg(args, name, String(fallback));
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function printHelp(): void {
  console.log(`Universal Agent Bridge

Usage:
  uab demo
  uab serve [--host 127.0.0.1] [--port 8787]
  uab call <runtime> <method> [jsonParams]

Examples:
  uab demo
  uab call mock sessions.list "{}"
  uab serve --port 8787

External HTTP runtime:
  UAB_HTTP_RUNTIME_URL=http://127.0.0.1:9000 uab serve

Hermes:
  UAB_HERMES_URL=http://127.0.0.1:8642 UAB_HERMES_TOKEN=change-me-local-dev uab serve

OpenClaw Gateway:
  UAB_OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789 UAB_OPENCLAW_TOKEN=... uab serve

OpenClaw CLI fallback:
  UAB_OPENCLAW_MODE=cli uab serve

MCP stdio server:
  UAB_MCP_SERVER_COMMAND=node UAB_MCP_SERVER_ARGS=examples/mcp-stdio-server/server.mjs uab serve

MCP HTTP server:
  UAB_MCP_SERVER_TRANSPORT=http UAB_MCP_SERVER_URL=http://127.0.0.1:3000/mcp uab serve

A2A agent:
  UAB_A2A_AGENT_URL=http://127.0.0.1:9010 uab serve
`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
