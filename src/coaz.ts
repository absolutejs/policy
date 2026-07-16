export type CoazMappingEntity = Record<string, string>;
export type CoazMapping = {
  subject: CoazMappingEntity[];
  resource: CoazMappingEntity[];
  action?: CoazMappingEntity[];
  context: CoazMappingEntity[];
};
export type CoazTool = {
  name: string;
  coaz?: boolean;
  inputSchema: Record<string, unknown> & { "x-coaz-mapping"?: CoazMapping };
};
export type CoazCelEvaluator = (
  expression: string,
  variables: {
    params: { name: string; arguments: Record<string, unknown> };
    token: Record<string, unknown>;
  },
) => unknown | Promise<unknown>;
export type AuthzenEvaluation = {
  subject: Record<string, unknown>;
  action: Record<string, unknown>;
  resource: Record<string, unknown>;
  context: Record<string, unknown>;
};
export type CoazRequest =
  | { endpoint: "evaluation"; body: AuthzenEvaluation }
  | {
      endpoint: "evaluations";
      body: Partial<AuthzenEvaluation> & {
        evaluations: Array<Partial<AuthzenEvaluation>>;
      };
    };

export const validateCoazTool = (tool: CoazTool): CoazMapping => {
  if (tool.coaz !== true)
    throw new Error("Tool is not declared COAZ compatible");
  const mapping = tool.inputSchema["x-coaz-mapping"];
  if (
    !mapping ||
    !Array.isArray(mapping.subject) ||
    !Array.isArray(mapping.resource) ||
    !Array.isArray(mapping.context) ||
    mapping.subject.length === 0 ||
    mapping.resource.length === 0 ||
    mapping.context.length === 0
  )
    throw new Error("Malformed x-coaz-mapping");
  const lengths = [
    mapping.subject.length,
    mapping.resource.length,
    mapping.action?.length ?? 1,
    mapping.context.length,
  ];
  const maximum = Math.max(...lengths);
  if (lengths.some((length) => length !== 1 && length !== maximum))
    throw new Error("COAZ mapping arrays have mismatched element counts");
  for (const entities of [
    mapping.subject,
    mapping.resource,
    mapping.action ?? [],
    mapping.context,
  ])
    for (const entity of entities)
      for (const expression of Object.values(entity))
        if (typeof expression !== "string" || expression.length === 0)
          throw new Error("COAZ mapping expressions must be non-empty strings");
  return mapping;
};

export const createCoazRequest = async ({
  tool,
  arguments: args,
  token,
  verifyToken,
  evaluate,
}: {
  tool: CoazTool;
  arguments: Record<string, unknown>;
  token: Record<string, unknown>;
  /** Must verify signature, issuer, audience, and expiration before claims are mapped. */
  verifyToken: (token: Record<string, unknown>) => boolean | Promise<boolean>;
  evaluate: CoazCelEvaluator;
}): Promise<CoazRequest> => {
  if (!(await verifyToken(token)))
    throw new Error("COAZ token verification failed");
  const mapping = validateCoazTool(tool);
  const variables = { params: { name: tool.name, arguments: args }, token };
  const resolveEntity = async (entity: CoazMappingEntity) =>
    Object.fromEntries(
      await Promise.all(
        Object.entries(entity).map(async ([key, expression]) => [
          key,
          await evaluate(expression, variables),
        ]),
      ),
    );
  const resolved = {
    subject: await Promise.all(mapping.subject.map(resolveEntity)),
    resource: await Promise.all(mapping.resource.map(resolveEntity)),
    action: await Promise.all(
      (
        mapping.action ?? [{ name: `'${tool.name.replaceAll("'", "\\'")}'` }]
      ).map(resolveEntity),
    ),
    context: await Promise.all(mapping.context.map(resolveEntity)),
  };
  const maximum = Math.max(
    resolved.subject.length,
    resolved.resource.length,
    resolved.action.length,
    resolved.context.length,
  );
  const at = (values: Record<string, unknown>[], index: number) =>
    structuredClone(values.length === 1 ? values[0]! : values[index]!);
  if (maximum === 1)
    return {
      endpoint: "evaluation",
      body: {
        subject: at(resolved.subject, 0),
        resource: at(resolved.resource, 0),
        action: at(resolved.action, 0),
        context: at(resolved.context, 0),
      },
    };
  const defaults: Partial<AuthzenEvaluation> = {};
  if (resolved.subject.length === 1) defaults.subject = at(resolved.subject, 0);
  if (resolved.resource.length === 1)
    defaults.resource = at(resolved.resource, 0);
  if (resolved.action.length === 1) defaults.action = at(resolved.action, 0);
  if (resolved.context.length === 1) defaults.context = at(resolved.context, 0);
  return {
    endpoint: "evaluations",
    body: {
      ...defaults,
      evaluations: Array.from({ length: maximum }, (_, index) => ({
        ...(resolved.subject.length > 1
          ? { subject: at(resolved.subject, index) }
          : {}),
        ...(resolved.resource.length > 1
          ? { resource: at(resolved.resource, index) }
          : {}),
        ...(resolved.action.length > 1
          ? { action: at(resolved.action, index) }
          : {}),
        ...(resolved.context.length > 1
          ? { context: at(resolved.context, index) }
          : {}),
      })),
    },
  };
};

export const COAZ_ERROR_CODES = {
  mapping: -32602,
  denied: -32401,
  pdpUnavailable: -32603,
} as const;
export const enforceCoazDecisions = (
  decisions: readonly { decision: boolean }[],
): void => {
  if (
    decisions.length === 0 ||
    decisions.some((decision) => decision.decision !== true)
  ) {
    const error = new Error(
      "AuthZEN denied the MCP tool invocation",
    ) as Error & { code: number };
    error.code = COAZ_ERROR_CODES.denied;
    throw error;
  }
};
