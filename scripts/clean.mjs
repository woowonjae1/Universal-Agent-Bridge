import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const targets = [
  "packages/protocol/dist",
  "packages/protocol/tsconfig.tsbuildinfo",
  "packages/adapter-sdk/dist",
  "packages/adapter-sdk/tsconfig.tsbuildinfo",
  "packages/core/dist",
  "packages/core/tsconfig.tsbuildinfo",
  "packages/adapter-mock/dist",
  "packages/adapter-mock/tsconfig.tsbuildinfo",
  "packages/transport-http/dist",
  "packages/transport-http/tsconfig.tsbuildinfo",
  "packages/cli/dist",
  "packages/cli/tsconfig.tsbuildinfo"
];

await Promise.all(
  targets.map((target) =>
    rm(join(root, target), { recursive: true, force: true })
  )
);
