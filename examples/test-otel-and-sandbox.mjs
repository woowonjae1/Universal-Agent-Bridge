import { AgentBridge } from "@uab/core";
import { createHostAdapter } from "@uab/adapter-host";
import { OpenTelemetrySpanExporter } from "@uab/core";
import path from "node:path";

console.log("\n=======================================================");
console.log("🚀 UAB 治理与安全沙箱验证脚本 (OTel & Sandbox Verification)");
console.log("=======================================================\n");

const bridge = new AgentBridge();
const hostAdapter = createHostAdapter();
bridge.register(hostAdapter);

async function runTests() {
  let passedCount = 0;
  let failedCount = 0;

  function assert(name, condition) {
    if (condition) {
      console.log(`   ✅ 测试通过: ${name}`);
      passedCount++;
    } else {
      console.error(`   ❌ 测试失败: ${name}`);
      failedCount++;
    }
  }

  // 1. 验证 OpenTelemetry 导出器初始化与导出安全（不报错）
  console.log("-> 1. 验证 OpenTelemetry Span 导出器...");
  try {
    const otelExporter = new OpenTelemetrySpanExporter();
    const mockSpan = {
      name: "uab.test_method",
      traceId: "trace_123",
      spanId: "span_123",
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      durationMs: 50,
      status: "ok",
      attributes: { "uab.runtime": "host" }
    };
    await otelExporter.export(mockSpan);
    assert("OTel 导出器在缺少全局 OTel API 时静默降级，不抛出异常", true);
  } catch (err) {
    assert("OTel 导出器未发生异常", false);
  }

  // 2. 验证文件沙箱机制 (Filesystem Sandboxing)
  console.log("\n-> 2. 验证文件沙箱沙盒权限策略...");
  
  // A. 合法读取当前工作目录下的文件
  try {
    const pkgPath = path.resolve("package.json");
    const result = await bridge.handleRequest({
      jsonrpc: "2.0",
      id: "req_sandbox_1",
      runtime: "host",
      method: "read_file",
      params: { path: pkgPath }
    });
    console.log("Debug result 1:", result);
    assert("沙箱允许读取授权目录下的 package.json", result.result !== undefined);
  } catch (err) {
    console.log("Debug error 1:", err);
    assert("沙箱允许读取授权目录下的 package.json", false);
  }

  // B. 越界读取禁止的文件目录 (Path Traversal)
  try {
    const illegalPath = "C:\\Windows\\win.ini";
    const result = await bridge.handleRequest({
      jsonrpc: "2.0",
      id: "req_sandbox_2",
      runtime: "host",
      method: "read_file",
      params: { path: illegalPath }
    });
    assert("沙箱应当拦截非授权目录的读取", result.error !== undefined && String(result.error.message).includes("Security Exception"));
  } catch (err) {
    assert("沙箱应当拦截非授权目录的读取", false);
  }

  // 3. 验证命令执行白名单控制 (Command Execution Whitelisting)
  console.log("\n-> 3. 验证命令执行白名单安全策略...");

  // A. 执行白名单内的命令
  try {
    const result = await bridge.handleRequest({
      jsonrpc: "2.0",
      id: "req_exec_1",
      runtime: "host",
      method: "exec",
      params: { command: "git status" }
    });
    assert("允许执行白名单中的命令 'git status'", result.result !== undefined);
  } catch (err) {
    assert("允许执行白名单中的命令 'git status'", false);
  }

  // B. 执行不在白名单内的命令
  try {
    const result = await bridge.handleRequest({
      jsonrpc: "2.0",
      id: "req_exec_2",
      runtime: "host",
      method: "exec",
      params: { command: "whoami" }
    });
    assert("拦截非法指令 'whoami' 的执行", result.error !== undefined && String(result.error.message).includes("Security Exception"));
  } catch (err) {
    assert("拦截非法指令 'whoami' 的执行", false);
  }

  console.log("\n=======================================================");
  console.log(`📊 验证统计: 成功 ${passedCount} / 失败 ${failedCount}`);
  console.log("=======================================================");
  
  if (failedCount > 0) {
    process.exit(1);
  }
}

runTests();
