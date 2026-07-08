import { AgentBridge } from "@uab/core";
import { createHostAdapter } from "@uab/adapter-host";

const bridge = new AgentBridge();
bridge.register(createHostAdapter());

console.log("\n=======================================================");
console.log("验证 UAB 新特性：原生系统适配器 & Plan 模板参数插值");
console.log("=======================================================\n");

// 1. 验证剪贴板读写能力
console.log("-> 1. 验证剪贴板读写 (host.clipboard_write / read)...");
const testText = "Universal-Agent-Bridge: " + Date.now();
await bridge.handleRequest({
  jsonrpc: "2.0",
  id: "write_clip",
  runtime: "host",
  method: "clipboard_write",
  params: { text: testText }
});

const readResult = await bridge.handleRequest({
  jsonrpc: "2.0",
  id: "read_clip",
  runtime: "host",
  method: "clipboard_read",
  params: {}
});

const clipboardText = readResult.result?.text;
console.log(`   [写入文本]: "${testText}"`);
console.log(`   [读取文本]: "${clipboardText}"`);
if (clipboardText === testText) {
  console.log("   ✅ 剪贴板读写验证成功！");
} else {
  console.error("   ❌ 剪贴板文本不匹配！");
}

// 2. 验证 Plan 模板插值运行
console.log("\n-> 2. 验证 Plan 模板变量参数插值与文件读取...");
const template = {
  id: "template_demo",
  mode: "dag",
  steps: [
    {
      id: "read_package_json",
      runtime: "host",
      method: "read_file",
      params: { path: "{{target_path}}" }
    }
  ]
};

const variables = {
  target_path: "d:/code/Universal-Agent-Bridge/package.json"
};

console.log("   [插值前参数]:", JSON.stringify(template.steps[0].params));
const instantiatedPlan = bridge.instantiatePlan(template, variables);
console.log("   [插值后参数]:", JSON.stringify(instantiatedPlan.steps[0].params));

console.log("   正在执行实例化后的 Plan...");
const runResult = await bridge.runPlan(instantiatedPlan);

console.log("\n✅ 计划执行完毕！");
console.log("=======================================================");

const stepResult = runResult.steps[0];
console.log(`- 步骤状态: ${stepResult.status}`);
if (stepResult.status === "success") {
  const fileContent = stepResult.response?.result;
  const parsed = JSON.parse(fileContent);
  console.log(`- 成功读取文件: ${variables.target_path}`);
  console.log(`- 项目名称 (package.json name): "${parsed.name}"`);
  console.log("  ✅ UAB Plan 模板参数插值执行验证成功！");
} else {
  console.error("  ❌ 执行失败:", stepResult.response?.error?.message);
}
console.log("=======================================================\n");
