import { and, desc, eq } from "drizzle-orm";
import {
  bigint,
  customType,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  type PgAsyncDatabase,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-typebox";
import type { PolicyDocument, PolicyStatus, PolicyStore } from "./index";

const portableJsonb = customType<{ data: unknown; driverData: unknown }>({
  dataType: () => "jsonb",
  fromDriver: (value) =>
    typeof value === "string" ? JSON.parse(value) : value,
  toDriver: (value) => JSON.stringify(value),
});

export const policyVersions = pgTable(
  "policy_versions",
  {
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    createdBy: text("created_by").notNull(),
    digest: text().notNull(),
    policyId: text("policy_id").notNull(),
    provider: text().notNull(),
    source: portableJsonb().notNull(),
    status: text().$type<PolicyStatus>().notNull(),
    version: integer().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.policyId, table.version],
      name: "policy_versions_pkey",
    }),
    index("policy_versions_history_idx").on(
      table.policyId,
      table.version.desc(),
    ),
    uniqueIndex("policy_one_active_idx")
      .on(table.policyId)
      .where(eq(table.status, "active")),
  ],
);

export const policyDrizzleSchema = { policyVersions };
export const PolicyVersionInsertSchema = createInsertSchema(policyVersions);
export const PolicyVersionSelectSchema = createSelectSchema(policyVersions);

type AnyPgDatabase = PgAsyncDatabase<any, any>;

export type CreateDrizzlePolicyStoreOptions<DB extends AnyPgDatabase> = {
  db: DB;
};

const fromRow = (row: typeof policyVersions.$inferSelect): PolicyDocument => ({
  createdAt: row.createdAt,
  createdBy: row.createdBy,
  digest: row.digest,
  policyId: row.policyId,
  provider: row.provider,
  source: row.source,
  status: row.status,
  version: row.version,
});

export const createDrizzlePolicyStore = <DB extends AnyPgDatabase>({
  db,
}: CreateDrizzlePolicyStoreOptions<DB>): PolicyStore => ({
  activate: (policyId, version) =>
    db.transaction(async (transaction) => {
      const versions = await transaction
        .select({ version: policyVersions.version })
        .from(policyVersions)
        .where(eq(policyVersions.policyId, policyId))
        .for("update");
      if (!versions.some((candidate) => candidate.version === version))
        return false;
      await transaction
        .update(policyVersions)
        .set({ status: "retired" })
        .where(
          and(
            eq(policyVersions.policyId, policyId),
            eq(policyVersions.status, "active"),
          ),
        );
      const activated = await transaction
        .update(policyVersions)
        .set({ status: "active" })
        .where(
          and(
            eq(policyVersions.policyId, policyId),
            eq(policyVersions.version, version),
          ),
        )
        .returning({ version: policyVersions.version });

      return activated.length === 1;
    }),
  get: async (policyId, version) => {
    const [row] = await db
      .select()
      .from(policyVersions)
      .where(
        and(
          eq(policyVersions.policyId, policyId),
          eq(policyVersions.version, version),
        ),
      )
      .limit(1);

    return row === undefined ? undefined : fromRow(row);
  },
  getActive: async (policyId) => {
    const [row] = await db
      .select()
      .from(policyVersions)
      .where(
        and(
          eq(policyVersions.policyId, policyId),
          eq(policyVersions.status, "active"),
        ),
      )
      .limit(1);

    return row === undefined ? undefined : fromRow(row);
  },
  list: async (policyId) =>
    (
      await db
        .select()
        .from(policyVersions)
        .where(eq(policyVersions.policyId, policyId))
        .orderBy(desc(policyVersions.version))
    ).map(fromRow),
  save: async (document) =>
    (
      await db
        .insert(policyVersions)
        .values(document)
        .onConflictDoNothing()
        .returning({ version: policyVersions.version })
    ).length === 1,
});
