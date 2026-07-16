# @absolutejs/policy

Immutable, provider-neutral policy lifecycle for agent actions. Drafts are
validated and content-digested, versions only increase, activation atomically
retires the previous version, evaluations record the exact version and digest,
and simulation evaluates an unpersisted candidate without changing live policy.

`createAuthzenAdapter()` speaks the OpenID AuthZEN evaluation API while custom
adapters can target Cedar, OPA, cloud IAM, or an embedded rules engine. PostgreSQL
enforces one active version per policy with a partial unique index.

Version 0.2 adds direct support for the OpenID AuthZEN AARP and COAZ Working
Group Drafts. AARP helpers extract requestable denials, preserve their binding,
submit idempotent access requests, persist portable task handles, and only
produce approval context for a fresh PDP evaluation. COAZ validates MCP
`coaz` / `x-coaz-mapping` declarations and constructs single or aligned bulk
SARC requests through an injected CEL evaluator. Any mapping, PDP, or decision
failure denies tool execution.
