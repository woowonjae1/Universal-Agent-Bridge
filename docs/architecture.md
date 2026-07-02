# Architecture

Universal Agent Bridge has four layers.

## Protocol

The protocol package defines the JSON-RPC style request and response envelope. It does not know about HTTP, MQTT, OpenClaw, Hermes, or any other runtime.

## Core

The core package owns adapter registration, request validation, runtime routing, and access policy checks.

## Adapters

Adapters implement runtime-specific behavior. OpenClaw, Hermes, and other agent systems should each live behind the same `AgentRuntimeAdapter` contract.

## Transports

Transports receive external messages and hand them to the bridge core. They should not contain runtime-specific logic.

```text
Transport -> AgentBridge.handleRequest -> AdapterRegistry -> Runtime Adapter
```

## Design Principles

- Runtime-specific code belongs in adapters.
- Transport-specific code belongs in transport packages.
- Permissions are evaluated before adapter calls.
- Capability discovery is the public contract for heterogeneous runtimes.
- Production and local development paths should use real runtime adapters or explicit local test fixtures.
