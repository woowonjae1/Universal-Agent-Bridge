import type { AgentRuntimeAdapter } from "@uab/adapter-sdk";

export class AdapterRegistry {
  private readonly adapters = new Map<string, AgentRuntimeAdapter>();

  register(adapter: AgentRuntimeAdapter): void {
    const id = adapter.info.id.trim();
    if (!id) {
      throw new Error("Adapter id is required.");
    }

    if (this.adapters.has(id)) {
      throw new Error(`Adapter '${id}' is already registered.`);
    }

    this.adapters.set(id, adapter);
  }

  unregister(runtimeId: string): boolean {
    return this.adapters.delete(runtimeId);
  }

  get(runtimeId: string): AgentRuntimeAdapter | undefined {
    return this.adapters.get(runtimeId);
  }

  list(): AgentRuntimeAdapter[] {
    return [...this.adapters.values()];
  }

  clear(): void {
    this.adapters.clear();
  }
}

