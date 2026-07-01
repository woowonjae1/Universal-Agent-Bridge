#!/usr/bin/env node
import { createHermesAdapter } from "@uab/adapter-hermes";
import { createHttpJsonRpcAdapter } from "@uab/adapter-http-jsonrpc";
import { createMockAdapter } from "@uab/adapter-mock";
import { createOpenClawAdapter } from "@uab/adapter-openclaw";
import { AgentBridge } from "@uab/core";
import { createHttpBridgeServer, listen } from "@uab/transport-http";
import type { BridgeRequest } from "@uab/protocol";

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
      mode: cliMode ? "cli" : "gateway",
      cliCommand: process.env.UAB_OPENCLAW_CLI,
      scopes: readCsvEnv("UAB_OPENCLAW_SCOPES"),
      timeoutMs: readEnvNumber("UAB_OPENCLAW_TIMEOUT_MS", 30_000)
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
`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
