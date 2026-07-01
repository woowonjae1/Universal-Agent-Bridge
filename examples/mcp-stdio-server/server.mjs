#!/usr/bin/env node
import { createInterface } from "node:readline";

const tools = [
  {
    name: "echo",
    title: "Echo",
    description: "Return the provided text.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" }
      },
      required: ["text"]
    }
  },
  {
    name: "time.now",
    title: "Current Time",
    description: "Return the current ISO timestamp.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  }
];

const lines = createInterface({
  input: process.stdin
});

lines.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.id === undefined || message.id === null) return;

  try {
    switch (message.method) {
      case "initialize":
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
            capabilities: {
              tools: {}
            },
            serverInfo: {
              name: "uab-example-mcp",
              version: "0.1.0"
            }
          }
        });
        break;
      case "tools/list":
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools
          }
        });
        break;
      case "tools/call":
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: callTool(message.params?.name, message.params?.arguments ?? {})
        });
        break;
      default:
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32601,
            message: `Method '${message.method}' is not supported.`
          }
        });
    }
  } catch (error) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : String(error)
      }
    });
  }
});

function callTool(name, args) {
  if (name === "echo") {
    return {
      content: [
        {
          type: "text",
          text: String(args.text ?? "")
        }
      ],
      isError: false
    };
  }

  if (name === "time.now") {
    return {
      content: [
        {
          type: "text",
          text: new Date().toISOString()
        }
      ],
      isError: false
    };
  }

  return {
    content: [
      {
        type: "text",
        text: `Unknown tool '${name}'.`
      }
    ],
    isError: true
  };
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
