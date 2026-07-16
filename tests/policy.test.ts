import { describe, expect, test } from "bun:test";
import {
  createAuthzenAdapter,
  createMemoryPolicyStore,
  createPolicyEngine,
  policyPostgresSchemaSql,
} from "../src";

describe("versioned policy lifecycle", () => {
  test("drafts immutable versions, atomically activates, evaluates, and simulates", async () => {
    const store = createMemoryPolicyStore();
    const engine = createPolicyEngine<{ amount: number }>({
      adapters: {
        local: {
          evaluate: async (document, input) => ({
            allowed:
              input.amount <= (document.source as { maximum: number }).maximum,
            reason: "limit",
          }),
        },
      },
      now: () => 100,
      store,
    });
    const first = await engine.draft({
      createdBy: "admin",
      policyId: "spend",
      provider: "local",
      source: { maximum: 10 },
    });
    const second = await engine.draft({
      createdBy: "admin",
      policyId: "spend",
      provider: "local",
      source: { maximum: 20 },
    });
    expect([first.version, second.version]).toEqual([1, 2]);
    expect(await engine.activate("spend", 2)).toBe(true);
    const decision = await engine.evaluate("spend", { amount: 15 });
    expect(decision).toMatchObject({ allowed: true, policyVersion: 2 });
    const simulation = await engine.simulate(
      { provider: "local", source: { maximum: 5 } },
      { amount: 15 },
    );
    expect(simulation.allowed).toBe(false);
    expect((await store.getActive("spend"))?.version).toBe(2);
  });

  test("ships a one-active-version PostgreSQL invariant", () => {
    const sql = policyPostgresSchemaSql();
    expect(sql).toContain("policy_one_active_idx");
    expect(sql).toContain("WHERE status = 'active'");
    expect(() => policyPostgresSchemaSql("bad-name")).toThrow();
  });

  test("maps the AuthZEN decision response without provider lock-in", async () => {
    let requestBody: unknown;
    const adapter = createAuthzenAdapter<{ subject: string }>({
      endpoint: "https://pdp.test/access/v1/evaluation",
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return Response.json({
          decision: true,
          context: { policy: "central" },
        });
      },
      mapRequest: (input) => ({ subject: { id: input.subject } }),
    });
    const result = await adapter.evaluate(
      {
        createdAt: 1,
        createdBy: "admin",
        digest: "digest",
        policyId: "access",
        provider: "authzen",
        source: {},
        status: "active",
        version: 1,
      },
      { subject: "user-1" },
    );
    expect(requestBody).toEqual({ subject: { id: "user-1" } });
    expect(result).toMatchObject({
      allowed: true,
      metadata: { policy: "central" },
    });
  });
});
