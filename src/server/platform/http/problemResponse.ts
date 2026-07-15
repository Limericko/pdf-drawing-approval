import type { Response } from "express";
import type { ProblemDetails } from "../../../shared/contracts/problem.ts";

export class HttpProblem extends Error {
  constructor(readonly status: number, readonly code: string, readonly title: string) {
    super(code);
    this.name = "HttpProblem";
  }
}

export function sendProblem(response: Response, problem: Omit<ProblemDetails, "type">) {
  return response.status(problem.status).type("application/problem+json").json({ type: "about:blank", ...problem });
}
