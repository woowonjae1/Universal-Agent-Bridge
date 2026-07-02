import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const targets = [
  "packages/protocol/dist",
  "packages/protocol/tsconfig.tsbuildinfo",
  "packages/a2ui/dist",
  "packages/a2ui/tsconfig.tsbuildinfo",
  "packages/ag-ui/dist",
  "packages/ag-ui/tsconfig.tsbuildinfo",
  "packages/mcp/dist",
  "packages/mcp/tsconfig.tsbuildinfo",
  "packages/a2a/dist",
  "packages/a2a/tsconfig.tsbuildinfo",
  "packages/adapter-sdk/dist",
  "packages/adapter-sdk/tsconfig.tsbuildinfo",
  "packages/core/dist",
  "packages/core/tsconfig.tsbuildinfo",
  "packages/adapter-http-jsonrpc/dist",
  "packages/adapter-http-jsonrpc/tsconfig.tsbuildinfo",
  "packages/adapter-hermes/dist",
  "packages/adapter-hermes/tsconfig.tsbuildinfo",
  "packages/adapter-openclaw/dist",
  "packages/adapter-openclaw/tsconfig.tsbuildinfo",
  "packages/transport-http/dist",
  "packages/transport-http/tsconfig.tsbuildinfo",
  "apps/dashboard/dist",
  "apps/dashboard/tsconfig.tsbuildinfo",
  "apps/dashboard/tsconfig.node.tsbuildinfo",
  "packages/cli/dist",
  "packages/cli/tsconfig.tsbuildinfo"
];

await Promise.all(
  targets.map((target) =>
    rm(join(root, target), { recursive: true, force: true })
  )
);
