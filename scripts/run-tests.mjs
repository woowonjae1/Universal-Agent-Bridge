import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const packagesDir = join(root, "packages");
const packageNames = await readdir(packagesDir);
const testFiles = [];

async function collectTests(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectTests(fullPath);
    } else if (entry.isFile() && entry.name.endsWith(".test.js")) {
      testFiles.push(fullPath);
    }
  }
}

for (const packageName of packageNames) {
  await collectTests(join(packagesDir, packageName, "dist"));
}

if (testFiles.length === 0) {
  console.error("No compiled test files found. Run npm run build first.");
  process.exit(1);
}

const child = spawn(process.execPath, ["--test", ...testFiles], {
  stdio: "inherit",
  shell: false
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
