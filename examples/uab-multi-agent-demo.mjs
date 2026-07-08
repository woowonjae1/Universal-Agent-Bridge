import { AgentBridge } from "@uab/core";
import { createPiAdapter } from "@uab/adapter-pi";
import { createOpenClawAdapter } from "@uab/adapter-openclaw";

const bridge = new AgentBridge();
bridge.register(createOpenClawAdapter({ id: "openclaw", gatewayUrl: "ws://127.0.0.1:18789", token: "2373ff8bc2e239486265d2c31597266a4ff57911337a547b" }));
bridge.register(createPiAdapter({ id: "pi", piPath: "D:\\code\\pi\\pi_woowonjae" }));

const plan = {
  id: "multi_agent_pipeline_" + Date.now(),
  mode: "dag",
  timeoutMs: 60000,
  stopOnError: true,
  steps: [
    {
      id: "write",
      runtime: "openclaw",
      method: "agent.stream",
      stream: true,
      params: { message: "Write a 1-sentence slogan about why multi-agent collaboration is powerful." }
    },
    {
      id: "polish",
      runtime: "pi",
      dependsOn: ["write"],
      method: "agent",
      params: { message: "Rewrite this slogan to make it extremely punchy and professional: ${steps.write.stream.text}" }
    }
  ]
};

console.log("\n=======================================================");
console.log("Starting UAB Multi-Agent Pipeline...");
console.log("Coordinating [OpenClaw] and [Pi Agent] in a DAG plan");
console.log("=======================================================\n");

console.log("-> Running plan steps...");
const result = await bridge.runPlan(plan);

console.log("\n-> Pipeline execution completed!");
console.log("=======================================================");

const steps = Object.fromEntries(result.steps.map((s) => [s.stepId, s]));

const rawSlogan = steps.write.streamText;
const polishedSlogan = steps.polish.response?.result;

console.log("\n[OpenClaw original slogan]:");
console.log(`"${rawSlogan?.trim()}"`);

console.log("\n[Pi Agent polished version]:");
console.log(`"${polishedSlogan?.trim()}"`);
console.log("\n=======================================================");
