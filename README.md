# @absolutejs/policy

Immutable, provider-neutral policy lifecycle for agent actions. Drafts are
validated and content-digested, versions only increase, activation atomically
retires the previous version, evaluations record the exact version and digest,
and simulation evaluates an unpersisted candidate without changing live policy.

`createAuthzenAdapter()` speaks the OpenID AuthZEN evaluation API while custom
adapters can target Cedar, OPA, cloud IAM, or an embedded rules engine. PostgreSQL
enforces one active version per policy with a partial unique index.
