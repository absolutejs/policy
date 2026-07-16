export type PolicyStatus = "draft" | "active" | "retired";
export * from "./aarp";
export * from "./coaz";
export type PolicyDocument = {
  createdAt: number;
  createdBy: string;
  digest: string;
  policyId: string;
  provider: string;
  source: unknown;
  status: PolicyStatus;
  version: number;
};
export type PolicyDecision = {
  allowed: boolean;
  decisionId: string;
  evaluatedAt: number;
  metadata?: Record<string, unknown>;
  policyDigest: string;
  policyId: string;
  policyVersion: number;
  reason?: string;
};
export type PolicyAdapter<Input = unknown> = {
  evaluate: (
    document: PolicyDocument,
    input: Input,
  ) => Promise<
    Omit<
      PolicyDecision,
      | "decisionId"
      | "evaluatedAt"
      | "policyDigest"
      | "policyId"
      | "policyVersion"
    >
  >;
  validate?: (source: unknown) => Promise<void> | void;
};
export type PolicyStore = {
  activate: (policyId: string, version: number) => Promise<boolean>;
  get: (
    policyId: string,
    version: number,
  ) => Promise<PolicyDocument | undefined>;
  getActive: (policyId: string) => Promise<PolicyDocument | undefined>;
  list: (policyId: string) => Promise<PolicyDocument[]>;
  save: (document: PolicyDocument) => Promise<boolean>;
};

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
};
const digest = async (value: unknown) => {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonical(value)),
    ),
  );
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const createMemoryPolicyStore = (): PolicyStore => {
  const rows = new Map<string, PolicyDocument>();
  const key = (id: string, version: number) => `${id}:${version}`;
  return {
    activate: async (id, version) => {
      const target = rows.get(key(id, version));
      if (!target) return false;
      for (const [rowKey, row] of rows)
        if (row.policyId === id && row.status === "active")
          rows.set(rowKey, { ...row, status: "retired" });
      rows.set(key(id, version), { ...target, status: "active" });
      return true;
    },
    get: async (id, version) => structuredClone(rows.get(key(id, version))),
    getActive: async (id) =>
      structuredClone(
        [...rows.values()].find(
          (row) => row.policyId === id && row.status === "active",
        ),
      ),
    list: async (id) =>
      [...rows.values()]
        .filter((row) => row.policyId === id)
        .sort((a, b) => b.version - a.version)
        .map((row) => structuredClone(row)),
    save: async (document) => {
      const rowKey = key(document.policyId, document.version);
      if (rows.has(rowKey)) return false;
      rows.set(rowKey, structuredClone(document));
      return true;
    },
  };
};

export const createPolicyEngine = <Input>({
  adapters,
  now = Date.now,
  store,
}: {
  adapters: Record<string, PolicyAdapter<Input>>;
  now?: () => number;
  store: PolicyStore;
}) => {
  const draft = async ({
    createdBy,
    policyId,
    provider,
    source,
  }: {
    createdBy: string;
    policyId: string;
    provider: string;
    source: unknown;
  }) => {
    const adapter = adapters[provider];
    if (!adapter) throw new Error(`Unknown policy provider: ${provider}`);
    await adapter.validate?.(source);
    const versions = await store.list(policyId);
    const document: PolicyDocument = {
      createdAt: now(),
      createdBy,
      digest: await digest({
        policyId,
        provider,
        source,
        version: (versions[0]?.version ?? 0) + 1,
      }),
      policyId,
      provider,
      source: structuredClone(source),
      status: "draft",
      version: (versions[0]?.version ?? 0) + 1,
    };
    if (!(await store.save(document)))
      throw new Error("Policy version already exists");
    return document;
  };
  const evaluateDocument = async (
    document: PolicyDocument,
    input: Input,
  ): Promise<PolicyDecision> => {
    const adapter = adapters[document.provider];
    if (!adapter)
      throw new Error(`Unknown policy provider: ${document.provider}`);
    return {
      ...(await adapter.evaluate(document, input)),
      decisionId: `decision_${crypto.randomUUID()}`,
      evaluatedAt: now(),
      policyDigest: document.digest,
      policyId: document.policyId,
      policyVersion: document.version,
    };
  };
  return {
    activate: (policyId: string, version: number) =>
      store.activate(policyId, version),
    draft,
    evaluate: async (policyId: string, input: Input) => {
      const active = await store.getActive(policyId);
      if (!active) throw new Error("No active policy");
      return evaluateDocument(active, input);
    },
    simulate: async (
      { provider, source }: { provider: string; source: unknown },
      input: Input,
    ) =>
      evaluateDocument(
        {
          createdAt: now(),
          createdBy: "simulation",
          digest: await digest({ provider, source }),
          policyId: "simulation",
          provider,
          source,
          status: "draft",
          version: 0,
        },
        input,
      ),
  };
};

export type PolicyFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export const createAuthzenAdapter = <Input>({
  endpoint,
  fetch: request = fetch,
  headers,
  mapRequest,
}: {
  endpoint: string;
  fetch?: PolicyFetch;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  mapRequest: (input: Input, document: PolicyDocument) => unknown;
}): PolicyAdapter<Input> => ({
  evaluate: async (document, input) => {
    const supplied = typeof headers === "function" ? await headers() : headers;
    const response = await request(endpoint, {
      body: JSON.stringify(mapRequest(input, document)),
      headers: {
        "content-type": "application/json",
        ...Object.fromEntries(new Headers(supplied)),
      },
      method: "POST",
    });
    if (!response.ok) throw new Error(`AuthZEN PDP failed: ${response.status}`);
    const body = (await response.json()) as {
      decision?: boolean;
      context?: Record<string, unknown>;
    };
    if (typeof body.decision !== "boolean")
      throw new Error("Invalid AuthZEN decision response");
    return {
      allowed: body.decision,
      metadata: body.context,
      reason: body.decision ? undefined : "authzen_denied",
    };
  },
});

export type PolicySqlResult<Row> = { rows: Row[]; rowCount?: number };
export type PolicySqlClient = {
  query: <Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<PolicySqlResult<Row>>;
};
const nsOf = (value: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(value))
    throw new Error("Policy namespace must be a simple identifier");
  return value;
};
export const policyPostgresSchemaSql = (namespace = "policy") => {
  const ns = nsOf(namespace);
  return `CREATE SCHEMA IF NOT EXISTS ${ns}; CREATE TABLE IF NOT EXISTS ${ns}.versions (policy_id text NOT NULL, version integer NOT NULL, status text NOT NULL, digest text NOT NULL, data jsonb NOT NULL, created_at bigint NOT NULL, PRIMARY KEY (policy_id, version)); CREATE UNIQUE INDEX IF NOT EXISTS policy_one_active_idx ON ${ns}.versions (policy_id) WHERE status = 'active';`;
};
export const createPostgresPolicyStore = ({
  client,
  namespace = "policy",
}: {
  client: PolicySqlClient;
  namespace?: string;
}): PolicyStore => {
  const ns = nsOf(namespace);
  const one = async (sql: string, values: readonly unknown[]) => {
    const row = (
      await client.query<{ data: PolicyDocument | string }>(sql, values)
    ).rows[0];
    return row
      ? typeof row.data === "string"
        ? JSON.parse(row.data)
        : row.data
      : undefined;
  };
  return {
    activate: async (id, version) =>
      (
        await client.query(
          `WITH target AS (SELECT version FROM ${ns}.versions WHERE policy_id = $1 AND version = $2), retired AS (UPDATE ${ns}.versions SET status = 'retired', data = jsonb_set(data,'{status}','"retired"') WHERE policy_id = $1 AND status = 'active' AND EXISTS (SELECT 1 FROM target)), activated AS (UPDATE ${ns}.versions SET status = 'active', data = jsonb_set(data,'{status}','"active"') WHERE policy_id = $1 AND version = $2 RETURNING version) SELECT version FROM activated`,
          [id, version],
        )
      ).rows.length === 1,
    get: (id, version) =>
      one(`SELECT data FROM ${ns}.versions WHERE policy_id=$1 AND version=$2`, [
        id,
        version,
      ]),
    getActive: (id) =>
      one(
        `SELECT data FROM ${ns}.versions WHERE policy_id=$1 AND status='active'`,
        [id],
      ),
    list: async (id) =>
      (
        await client.query<{ data: PolicyDocument | string }>(
          `SELECT data FROM ${ns}.versions WHERE policy_id=$1 ORDER BY version DESC`,
          [id],
        )
      ).rows.map((row) =>
        typeof row.data === "string" ? JSON.parse(row.data) : row.data,
      ),
    save: async (document) =>
      (
        await client.query(
          `INSERT INTO ${ns}.versions (policy_id,version,status,digest,data,created_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT DO NOTHING RETURNING version`,
          [
            document.policyId,
            document.version,
            document.status,
            document.digest,
            JSON.stringify(document),
            document.createdAt,
          ],
        )
      ).rows.length === 1,
  };
};
