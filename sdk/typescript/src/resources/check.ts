import { ApiError, type Declared, type Undeclared } from "../core/api-error.js";
import type { ApiPromise } from "../core/api-promise.js";
import type { RequestOptions } from "../core/api-request.js";
import { noneAuth } from "../core/auth/schemes.js";
import type { RawClient } from "../core/raw-client.js";
import type { ErrorDecoders } from "../core/response-decoder.js";
import { uuid } from "../core/uuid.js";
import * as s from "../core/validation/index.js";
import { apiMcpRequestSchema, type ApiMcpRequest } from "../models/api-mcp-request.js";
import { checkAnswerSchema, type CheckAnswer } from "../models/check-answer.js";
import { problemSchema, type Problem } from "../models/problem.js";
import type { Servers } from "../servers.js";

export class Check {
  readonly #rawClient: RawClient;
  readonly #servers: Servers;

  constructor(rawClient: RawClient, servers: Servers) {
    this.#rawClient = rawClient;
    this.#servers = servers;
  }

  /**
   * Check a product title or model against CPSC recalls
   *
   * @remarks
   * Runs the rules a shop's sales get on the text you send. Our code doesn't store or log it. It
   * travels in the page address, so the web host's request logs may include it. At least one of
   * title and model is needed. Limited to 60 checks an hour per visitor.
   *
   * @returns The recalls this text comes near, closest first. An empty list means nothing came
   * near.
   *
   * @throws {@link Check.CheckRecallError} when the API answers with an error status — narrow on
   * `err.payload.kind`
   *
   * @throws {@link RecallReachPublicApiError} when no usable response was produced: a connection
   * failure, a timeout, a body that would not decode, a value that would not encode, or a
   * credential that could not be obtained
   */
  checkRecall(
    request: Check.CheckRecallRequest = {},
    options?: RequestOptions,
  ): ApiPromise<CheckAnswer, Check.CheckRecallError> {
    return this.#rawClient.execute(
      {
        method: "GET",
        urlTemplate: this.#servers.default("/api/check"),
        auth: noneAuth,
        pathParams: [],
        query: [
          { name: "title", value: request.title, schema: s.optional(s.string()) },
          { name: "model", value: request.model, schema: s.optional(s.string()) },
        ],
        headers: [],
        body: { kind: "empty" },
      },
      {
        success: { kind: "json", schema: checkAnswerSchema },
        errorFactory: Check.CheckRecallError,
      },
      options,
    );
  }

  /**
   * The same check as an MCP tool over Streamable HTTP
   *
   * @remarks
   * Two read-only tools: check_recall(title, model), and get_recall(recallNumber), which gives one
   * recall's CPSC text. Stateless: each request stands alone. Send JSON-RPC 2.0, with Accept
   * application/json, text/event-stream. It shares the limit of /api/check.
   *
   * @returns A JSON-RPC response.
   *
   * @throws {@link Check.McpError} when the API answers with an error status — narrow on
   * `err.payload.kind`
   *
   * @throws {@link RecallReachPublicApiError} when no usable response was produced: a connection
   * failure, a timeout, a body that would not decode, a value that would not encode, or a
   * credential that could not be obtained
   */
  mcp(
    request: Check.McpRequest,
    options?: RequestOptions,
  ): ApiPromise<Record<string, unknown>, Check.McpError> {
    return this.#rawClient.execute(
      {
        method: "POST",
        urlTemplate: this.#servers.default("/api/mcp"),
        auth: noneAuth,
        pathParams: [],
        query: [],
        headers: [{ name: "Idempotency-Key", value: uuid(), schema: s.string() }],
        body: { kind: "json", value: request.body, schema: apiMcpRequestSchema },
      },
      {
        success: { kind: "json", schema: s.record(s.string(), s.unknown()) },
        errorFactory: Check.McpError,
      },
      options,
    );
  }

  /**
   * Not offered. Every answer comes back on its own POST.
   *
   * @remarks
   * The server is stateless and opens no event stream, so a GET is refused with 405.
   *
   * @throws {@link Check.McpNoStreamError} when the API answers with an error status — narrow on
   * `err.payload.kind`
   *
   * @throws {@link RecallReachPublicApiError} when no usable response was produced: a connection
   * failure, a timeout, a body that would not decode, a value that would not encode, or a
   * credential that could not be obtained
   */
  mcpNoStream(options?: RequestOptions): ApiPromise<undefined, Check.McpNoStreamError> {
    return this.#rawClient.execute(
      {
        method: "GET",
        urlTemplate: this.#servers.default("/api/mcp"),
        auth: noneAuth,
        pathParams: [],
        query: [],
        headers: [],
        body: { kind: "empty" },
      },
      {
        success: { kind: "empty" },
        errorFactory: Check.McpNoStreamError,
      },
      options,
    );
  }
}

export namespace Check {
  export type CheckRecallRequest = {
    /** The product's title, as a listing or a label would say it. */
    title?: string;
    /** The model number, if you have one. Compared with the models CPSC names. */
    model?: string;
  };

  export class CheckRecallError extends ApiError {
    declare readonly payload:
      | Declared<"problem", Problem>
      | Declared<"problem2", Problem>
      | Declared<"problem3", Problem>
      | Undeclared;

    static readonly errors: ErrorDecoders<CheckRecallError> = [
      { on: 400, kind: "problem", decode: { kind: "json", schema: problemSchema } },
      { on: 429, kind: "problem2", decode: { kind: "json", schema: problemSchema } },
      { on: 503, kind: "problem3", decode: { kind: "json", schema: problemSchema } },
    ];
  }

  export type McpRequest = {
    body: ApiMcpRequest;
  };

  export class McpError extends ApiError {
    declare readonly payload: Declared<"problem", Problem> | Undeclared;

    static readonly errors: ErrorDecoders<McpError> = [
      { on: 413, kind: "problem", decode: { kind: "json", schema: problemSchema } },
    ];
  }

  export class McpNoStreamError extends ApiError {
    declare readonly payload: Declared<"problem", Problem> | Undeclared;

    static readonly errors: ErrorDecoders<McpNoStreamError> = [
      { on: 405, kind: "problem", decode: { kind: "json", schema: problemSchema } },
    ];
  }
}
