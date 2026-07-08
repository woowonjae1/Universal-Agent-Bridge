import WebSocket from "ws";

const socket = new WebSocket("ws://127.0.0.1:18789");

socket.on("open", () => {
  console.log("WebSocket connected.");
  
  const connectFrame = {
    type: "req",
    id: "req_1",
    method: "connect",
    params: {
      minProtocol: 4,
      maxProtocol: 4,
      client: {
        id: "gateway-client",
        version: "0.1.0",
        platform: "win32",
        mode: "backend"
      },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      caps: [],
      commands: [],
      permissions: {},
      auth: {
        token: "2373ff8bc2e239486265d2c31597266a4ff57911337a547b"
      },
      locale: "en-US"
    }
  };
  socket.send(JSON.stringify(connectFrame));
});

socket.on("message", (data) => {
  const frame = JSON.parse(data.toString());
  
  // We only log non-health events to keep output readable
  if (frame.event !== "health" && frame.event !== "connect.challenge") {
    console.log("\n--- RECEIVED FRAME ---");
    console.log(JSON.stringify(frame, null, 2));
  }

  if (frame.type === "res" && frame.id === "req_1") {
    console.log("Connected successfully. Sending agent request...");
    const agentFrame = {
      type: "req",
      id: "req_2",
      method: "agent",
      params: {
        message: "Write a 1-sentence slogan about why multi-agent collaboration is powerful.",
        idempotencyKey: "test-idempotency-" + Date.now()
      }
    };
    socket.send(JSON.stringify(agentFrame));
    
    // Wait 12 seconds to capture all agent run stream frames
    setTimeout(() => {
      console.log("Closing socket after timeout.");
      socket.close();
    }, 12000);
  }
});

socket.on("close", () => {
  console.log("WebSocket closed.");
});
