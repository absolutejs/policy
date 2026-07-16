export type AuthzenEntity = Record<string, unknown>;
export type AarpRequestableDenial = {
  endpoint: string;
  evaluationId?: string;
  evaluatedAt?: string;
  reason?: string;
  expiresAt: string;
  bindingToken?: string;
  template?: string;
  display?: Record<string, unknown>;
  formUrl?: string;
  requestSchemaUrl?: string;
  requestCatalogsUrl?: string;
};
export type AarpAccessRequest = {
  subject: AuthzenEntity;
  resource?: AuthzenEntity;
  action?: AuthzenEntity;
  items?: Array<{
    resource: AuthzenEntity;
    action: AuthzenEntity;
    requested_access?: AuthzenEntity;
    denial?: AuthzenEntity;
  }>;
  context?: AuthzenEntity;
  requested_access?: AuthzenEntity;
  denial: {
    evaluation_id?: string;
    evaluated_at?: string;
    expires_at: string;
    reason?: string;
    binding_token?: string;
    template?: string;
  };
};
export type AarpTaskResponse = {
  task: {
    id: string;
    status: "pending" | "approved" | "denied" | "expired" | "cancelled";
    status_endpoint: string;
    expires_at?: string;
    progress?: Record<string, unknown>;
    display?: Record<string, unknown>;
    links?: Record<string, string>;
    items?: unknown[];
  };
  result?: {
    mode: string;
    approval?: { id: string; state?: string; approved_until?: string };
  };
};

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const https = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
};

/** Extracts a requestable denial from an AuthZEN decision. It never converts the denial into permission. */
export const readAarpRequestableDenial = (
  decision: { allowed: boolean; metadata?: Record<string, unknown> },
  pdpMetadata: { access_request_endpoint?: string },
  now = Date.now(),
): AarpRequestableDenial | undefined => {
  if (decision.allowed) return undefined;
  const context = object(decision.metadata);
  const hint = object(context?.access_request);
  if (
    !hint ||
    typeof hint.expires_at !== "string" ||
    Date.parse(hint.expires_at) <= now
  )
    return undefined;
  const endpoint =
    https(hint.endpoint) ?? https(pdpMetadata.access_request_endpoint);
  const evaluationId =
    typeof context?.evaluation_id === "string"
      ? context.evaluation_id
      : undefined;
  const bindingToken =
    typeof hint.binding_token === "string" ? hint.binding_token : undefined;
  if (!endpoint || (!evaluationId && !bindingToken)) return undefined;
  return {
    endpoint,
    expiresAt: hint.expires_at,
    ...(evaluationId ? { evaluationId } : {}),
    ...(bindingToken ? { bindingToken } : {}),
    ...(typeof context?.evaluated_at === "string"
      ? { evaluatedAt: context.evaluated_at }
      : {}),
    ...(typeof context?.reason === "string" ? { reason: context.reason } : {}),
    ...(typeof hint.template === "string" ? { template: hint.template } : {}),
    ...(object(hint.display) ? { display: object(hint.display) } : {}),
    ...(typeof hint.form_url === "string" ? { formUrl: hint.form_url } : {}),
    ...(typeof hint.request_schema_url === "string"
      ? { requestSchemaUrl: hint.request_schema_url }
      : {}),
    ...(typeof hint.request_catalogs_url === "string"
      ? { requestCatalogsUrl: hint.request_catalogs_url }
      : {}),
  };
};

export const createAarpAccessRequest = (
  denial: AarpRequestableDenial,
  request: Omit<AarpAccessRequest, "denial">,
): AarpAccessRequest => ({
  ...structuredClone(request),
  denial: {
    expires_at: denial.expiresAt,
    ...(denial.evaluationId ? { evaluation_id: denial.evaluationId } : {}),
    ...(denial.evaluatedAt ? { evaluated_at: denial.evaluatedAt } : {}),
    ...(denial.reason ? { reason: denial.reason } : {}),
    ...(denial.bindingToken ? { binding_token: denial.bindingToken } : {}),
    ...(denial.template ? { template: denial.template } : {}),
  },
});

export type AarpFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
export const createAarpClient = ({
  fetch: request = fetch,
  trustedOrigins,
  headers,
  maxResponseBytes = 65_536,
}: {
  fetch?: AarpFetch;
  trustedOrigins: string[];
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  maxResponseBytes?: number;
}) => {
  const call = async (
    urlValue: string,
    init: RequestInit,
  ): Promise<AarpTaskResponse> => {
    const url = new URL(urlValue);
    if (url.protocol !== "https:" || !trustedOrigins.includes(url.origin))
      throw new Error("Untrusted AARP endpoint");
    const supplied = typeof headers === "function" ? await headers() : headers;
    const response = await request(url, {
      ...init,
      redirect: "manual",
      headers: {
        accept: "application/json",
        ...Object.fromEntries(new Headers(supplied)),
        ...Object.fromEntries(new Headers(init.headers)),
      },
    });
    if (response.status >= 300 && response.status < 400)
      throw new Error("AARP redirects are denied");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxResponseBytes)
      throw new Error("AARP response is too large");
    if (!response.ok)
      throw new Error(`AARP service failed: ${response.status}`);
    const body = JSON.parse(
      new TextDecoder().decode(bytes),
    ) as AarpTaskResponse;
    if (
      !body.task ||
      typeof body.task.id !== "string" ||
      !https(body.task.status_endpoint)
    )
      throw new Error("Invalid AARP task response");
    return body;
  };
  return {
    submit: (
      denial: AarpRequestableDenial,
      body: AarpAccessRequest,
      idempotencyKey: string,
    ) =>
      call(denial.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify(body),
      }),
    status: (task: AarpTaskResponse["task"]) =>
      call(task.status_endpoint, { method: "GET" }),
  };
};

/** Approval is only input to a mandatory fresh AuthZEN evaluation. */
export const aarpReevaluationContext = (
  response: AarpTaskResponse,
):
  | { approval: NonNullable<AarpTaskResponse["result"]>["approval"] }
  | undefined =>
  response.task.status === "approved" &&
  response.result?.mode === "reevaluate" &&
  response.result.approval
    ? { approval: structuredClone(response.result.approval) }
    : undefined;
