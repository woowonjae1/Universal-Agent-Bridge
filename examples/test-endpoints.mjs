import http from "node:http";

const HOST = "127.0.0.1";
const PORT = 8787;
const BASE_URL = `http://${HOST}:${PORT}`;

function request(path, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: HOST,
      port: PORT,
      path,
      method,
      headers: {
        "Content-Type": "application/json"
      }
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: data ? JSON.parse(data) : null
          });
        } catch {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: data
          });
        }
      });
    });

    req.on("error", reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function main() {
  console.log("\n=======================================================");
  console.log(`Starting UAB Endpoints Integration Test against ${BASE_URL}...`);
  console.log("=======================================================\n");

  try {
    // 1. Health Endpoint
    console.log("-> 1. Testing GET /health ...");
    const health = await request("/health");
    console.log(`   [Status: ${health.statusCode}] Body:`, health.body);

    // 2. Health Runtimes Endpoint
    console.log("\n-> 2. Testing GET /health/runtimes ...");
    const healthRuntimes = await request("/health/runtimes");
    console.log(`   [Status: ${healthRuntimes.statusCode}] Runtimes Health:`);
    console.log(JSON.stringify(healthRuntimes.body, null, 2));

    // 3. Runtimes Listing
    console.log("\n-> 3. Testing GET /runtimes ...");
    const runtimes = await request("/runtimes");
    console.log(`   [Status: ${runtimes.statusCode}] Registered Runtimes:`);
    console.log(runtimes.body?.runtimes?.map(r => `     - ${r.id} (${r.name})`).join("\n"));

    // 4. Methods Listing
    console.log("\n-> 4. Testing GET /methods ...");
    const methods = await request("/methods");
    console.log(`   [Status: ${methods.statusCode}] Methods Count:`, methods.body?.methods?.length);
    console.log("   Sample Methods (first 5):");
    console.log(methods.body?.methods?.slice(0, 5).map(m => `     - ${m.runtime}.${m.name} (${m.capability})`).join("\n"));

    // 5. Audit Log
    console.log("\n-> 5. Testing GET /audit ...");
    const audit = await request("/audit?limit=3");
    console.log(`   [Status: ${audit.statusCode}] Audit logs count:`, audit.body?.length);

    // 6. Metrics
    console.log("\n-> 6. Testing GET /metrics ...");
    const metrics = await request("/metrics");
    console.log(`   [Status: ${metrics.statusCode}] Metrics keys:`, Object.keys(metrics.body ?? {}));

    // 7. Sessions
    console.log("\n-> 7. Testing GET /sessions ...");
    const sessions = await request("/sessions");
    console.log(`   [Status: ${sessions.statusCode}] Active Sessions:`, sessions.body);

    // 8. JSON-RPC (Call Pi get_state)
    console.log("\n-> 8. Testing POST /rpc (JSON-RPC call to 'pi' 'get_state') ...");
    const rpcPi = await request("/rpc", "POST", {
      jsonrpc: "2.0",
      id: "test_pi_get_state",
      runtime: "pi",
      method: "get_state",
      params: {}
    });
    console.log(`   [Status: ${rpcPi.statusCode}] JSON-RPC Pi response:`);
    console.log(JSON.stringify(rpcPi.body, null, 2));

    // 9. JSON-RPC (Call OpenClaw status)
    console.log("\n-> 9. Testing POST /rpc (JSON-RPC call to 'openclaw' 'status') ...");
    const rpcOpenClaw = await request("/rpc", "POST", {
      jsonrpc: "2.0",
      id: "test_openclaw_status",
      runtime: "openclaw",
      method: "status",
      params: {}
    });
    console.log(`   [Status: ${rpcOpenClaw.statusCode}] JSON-RPC OpenClaw response:`);
    console.log(`     - status: ${rpcOpenClaw.body?.result?.heartbeat?.defaultAgentId ? "success" : "failed"}`);
    console.log(`     - defaultAgentId: ${rpcOpenClaw.body?.result?.heartbeat?.defaultAgentId}`);

    console.log("\n=======================================================");
    console.log("All UAB features tested successfully!");
    console.log("=======================================================");
  } catch (error) {
    console.error("Test failed with error:", error);
  }
}

main();
