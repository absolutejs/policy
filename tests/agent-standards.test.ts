import { describe, expect, test } from "bun:test";
import {
  aarpReevaluationContext,
  createAarpAccessRequest,
  createCoazRequest,
  enforceCoazDecisions,
  readAarpRequestableDenial,
} from "../src";

const evaluate = async (expression: string, { params, token }: any) =>
  expression.startsWith("'")
    ? expression.slice(1, -1)
    : expression === "token.sub"
      ? token.sub
      : expression === "token.client_id"
        ? token.client_id
        : expression.includes("source")
          ? params.arguments.source
          : params.arguments.destination;
describe("AuthZEN agent standards", () => {
  test("AARP keeps requestable denial bound and requires re-evaluation", () => {
    const denial = readAarpRequestableDenial(
      {
        allowed: false,
        metadata: {
          evaluation_id: "eval-1",
          reason: "approval_required",
          access_request: {
            expires_at: "2026-07-16T00:00:00Z",
            binding_token: "signed",
            template: "manager",
          },
        },
      },
      { access_request_endpoint: "https://pdp.example/requests" },
      Date.parse("2026-07-15T00:00:00Z"),
    );
    expect(denial?.endpoint).toBe("https://pdp.example/requests");
    expect(
      createAarpAccessRequest(denial!, {
        subject: { id: "user" },
        resource: { id: "doc" },
        action: { name: "read" },
      }).denial.binding_token,
    ).toBe("signed");
    expect(
      aarpReevaluationContext({
        task: {
          id: "task",
          status: "approved",
          status_endpoint: "https://pdp.example/task",
        },
        result: { mode: "reevaluate", approval: { id: "approval" } },
      }),
    ).toEqual({ approval: { id: "approval" } });
  });
  test("COAZ creates aligned bulk SARC evaluations and denies if any decision denies", async () => {
    const request = await createCoazRequest({
      tool: {
        name: "copy",
        coaz: true,
        inputSchema: {
          "x-coaz-mapping": {
            subject: [{ type: "'user'", id: "token.sub" }],
            resource: [
              { type: "'object'", id: "params.arguments.source" },
              { type: "'object'", id: "params.arguments.destination" },
            ],
            action: [{ name: "'read'" }, { name: "'write'" }],
            context: [{ agent: "token.client_id" }],
          },
        },
      },
      arguments: { source: "a", destination: "b" },
      token: { sub: "user", client_id: "agent" },
      verifyToken: () => true,
      evaluate,
    });
    expect(request.endpoint).toBe("evaluations");
    if (request.endpoint === "evaluations")
      expect(request.body.evaluations).toHaveLength(2);
    expect(() =>
      enforceCoazDecisions([{ decision: true }, { decision: false }]),
    ).toThrow("denied");
  });
});
