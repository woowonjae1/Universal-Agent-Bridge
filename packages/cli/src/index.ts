#!/usr/bin/env node
import { createMockAdapter } from "@uab/adapter-mock";
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
  console.log("Registered runtimes: mock");
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
`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

