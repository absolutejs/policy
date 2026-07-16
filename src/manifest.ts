import { defineManifest } from "@absolutejs/manifest";
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
  settings: Type.Object({}),
  wiring: [],
});
