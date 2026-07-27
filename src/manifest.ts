import { defineImplementation, defineManifest } from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";
export const manifest = defineManifest<Record<string, never>>()({
  contract: 2,
  identity: {
    accent: "#14b8a6",
    category: "security",
    description:
      "Immutable versioned policy lifecycle with atomic activation, dry-run simulation, provider adapters, AuthZEN evaluation, and PostgreSQL state.",
    docsUrl: "https://github.com/absolutejs/policy",
    name: "@absolutejs/policy",
    tagline: "Change agent policy safely, with evidence.",
  },
  product: {
    blocks: [
      {
        category: "security",
        componentExport: "PolicyReview",
        description:
          "Review a versioned policy, simulation evidence, and activation posture before changing enforcement.",
        frameworks: ["react", "client"],
        id: "policy_review",
        props: Type.Object({
          policyId: Type.String({ minLength: 1 }),
          version: Type.Optional(Type.Integer({ minimum: 1 })),
        }),
        title: "Policy review",
      },
    ],
    events: [
      {
        description:
          "Emitted after an approved immutable policy version becomes active.",
        id: "policy_activated",
        schema: Type.Object({
          policyId: Type.String(),
          version: Type.Integer({ minimum: 1 }),
        }),
        source: "package",
        title: "Policy activated",
      },
    ],
  },
  implements: [
    defineImplementation<never>()({
      contract: "policy/store",
      factory: "createMemoryPolicyStore",
      from: "@absolutejs/policy",
      title: "In memory (development only)",
      wiring: {
        code: "createMemoryPolicyStore()",
        imports: [
          { from: "@absolutejs/policy", names: ["createMemoryPolicyStore"] },
        ],
      },
    }),
    defineImplementation<never>()({
      contract: "policy/store",
      factory: "createDrizzlePolicyStore",
      from: "@absolutejs/policy/drizzle",
      requires: {
        peers: [
          {
            name: "drizzle-orm",
            range: ">=1.0.0-rc.4 <2",
            reason: "Typed Postgres policy persistence",
          },
        ],
        services: [
          { description: "Immutable policy version ledger", id: "postgres" },
        ],
      },
      title: "Drizzle Postgres (production, including Neon)",
      wiring: {
        code: "createDrizzlePolicyStore({ db })",
        imports: [
          {
            from: "@absolutejs/policy/drizzle",
            names: ["createDrizzlePolicyStore"],
          },
        ],
      },
    }),
  ],
  settings: Type.Object({}),
  slots: {
    store: {
      configPath: "$self",
      contract: "policy/store",
      description: "Where immutable policy versions and activation live",
      known: [
        "@absolutejs/policy#createMemoryPolicyStore",
        "@absolutejs/policy#drizzle",
      ],
      required: true,
    },
  },
  wiring: [
    {
      description:
        "Create the versioned policy store used by your Agency enforcement point.",
      id: "default",
      server: {
        code: "const policyStore = ${slot.store};",
        imports: [],
        placement: "module-scope",
      },
      title: "Create the versioned policy store",
    },
  ],
});
