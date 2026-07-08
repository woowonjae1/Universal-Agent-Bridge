import { AgentBridge } from "@uab/core";
import { createPiAdapter } from "@uab/adapter-pi";
import { createOpenClawAdapter } from "@uab/adapter-openclaw";

const bridge = new AgentBridge();
bridge.register(createOpenClawAdapter({ id: "openclaw", gatewayUrl: "ws://127.0.0.1:18789", token: "2373ff8bc2e239486265d2c31597266a4ff57911337a547b" }));
bridge.register(createPiAdapter({ id: "pi", piPath: "D:\\code\\pi\\pi_woowonjae" }));

const plan = {
  id: "multi_agent_pipeline",
  mode: "dag",
  timeoutMs: 60000,
  stopOnError: true,
  steps: [
    { id: "write", runtime: "openclaw", method: "agent.stream", stream: true, params: { message: "Write a 1-sentence slogan about why multi-agent collaboration is powerful." } },
    { id: "polish", runtime: "pi", method: "agent", params: { message: "Rewrite this slogan to make it extremely punchy and professional: ${steps.write.stream.text}" } }
  ]
};

// We will hook into the bridge's runPlan execution by inspecting the plan run object returned
const result = await bridge.runPlan(plan);
console.log("Steps in result:");
for (const step of result.steps) {
  console.log(`Step ID: ${step.stepId}, Status: ${step.status}`);
  console.log("Response:", JSON.stringify(step.response, null, 2));
  console.log("StreamText:", step.streamText);
}
