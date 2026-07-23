import { PGlite } from "@electric-sql/pglite";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";
import {
  createDrizzlePolicyStore,
  PolicyVersionInsertSchema,
} from "../src/drizzle";
import type { PolicyDocument } from "../src";

const createTestStore = async () => {
  const client = new PGlite();
  await client.exec(`
    CREATE TABLE policy_versions (
      policy_id text NOT NULL,
      version integer NOT NULL,
      status text NOT NULL,
      digest text NOT NULL,
      created_at bigint NOT NULL,
      created_by text NOT NULL,
      provider text NOT NULL,
      source jsonb NOT NULL,
      PRIMARY KEY (policy_id, version)
    );
    CREATE UNIQUE INDEX policy_one_active_idx
      ON policy_versions (policy_id) WHERE status = 'active';
  `);

  return createDrizzlePolicyStore({ db: drizzle({ client }) });
};

const document = (version: number): PolicyDocument => ({
  createdAt: version,
  createdBy: "admin",
  digest: `digest-${version}`,
  policyId: "agent-actions",
  provider: "local",
  source: { maximum: version * 10 },
  status: "draft",
  version,
});

describe("createDrizzlePolicyStore", () => {
  test("derives database TypeBoxes from the Drizzle table", () => {
    expect(Value.Check(PolicyVersionInsertSchema, document(1))).toBe(true);
  });

  test("keeps immutable versions and atomically moves the active pointer", async () => {
    const store = await createTestStore();
    expect(await store.save(document(1))).toBe(true);
    expect(await store.save(document(1))).toBe(false);
    expect(await store.save(document(2))).toBe(true);
    expect(await store.activate("agent-actions", 1)).toBe(true);
    expect((await store.getActive("agent-actions"))?.version).toBe(1);
    expect(await store.activate("agent-actions", 2)).toBe(true);
    expect((await store.getActive("agent-actions"))?.version).toBe(2);
    expect((await store.get("agent-actions", 1))?.status).toBe("retired");
    expect(
      (await store.list("agent-actions")).map(({ version }) => version),
    ).toEqual([2, 1]);
    expect(await store.activate("agent-actions", 3)).toBe(false);
  });
});
