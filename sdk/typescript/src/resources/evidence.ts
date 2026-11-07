import { ApiError, type Declared, type Undeclared } from "../core/api-error.js";
import type { ApiPromise } from "../core/api-promise.js";
import type { RequestOptions } from "../core/api-request.js";
import { noneAuth } from "../core/auth/schemes.js";
import type { RawClient } from "../core/raw-client.js";
import type { ErrorDecoders } from "../core/response-decoder.js";
import * as s from "../core/validation/index.js";
import { problemSchema, type Problem } from "../models/problem.js";
import { proofSchema, type Proof } from "../models/proof.js";
import { recallDaySchema, type RecallDay } from "../models/recall-day.js";
import { replayRunSchema, type ReplayRun } from "../models/replay-run.js";
import { shopSchema, type Shop } from "../models/shop.js";
import type { Servers } from "../servers.js";

export class Evidence {
  readonly #rawClient: RawClient;
  readonly #servers: Servers;

  constructor(rawClient: RawClient, servers: Servers) {
    this.#rawClient = rawClient;
    this.#servers = servers;
  }

  /**
   * The newest day of recalls in the latest Recall Replay, against the demo shop
   *
   * @remarks
   * Read from the latest stored Recall Replay run, so it costs no new check. Only the demo shop is
   * public.
   *
   * @returns That day's recalls and what each one found.
   *
   * @throws {@link Evidence.NewestRecallDayError} when the API answers with an error status -
   * narrow on `err.payload.kind`
   *
   * @throws {@link RecallReachPublicApiError} when no usable response was produced: a connection
   * failure, a timeout, a body that would not decode, a value that would not encode, or a
   * credential that could not be obtained
   */
  newestRecallDay(
    request: Evidence.NewestRecallDayRequest,
    options?: RequestOptions,
  ): ApiPromise<RecallDay, Evidence.NewestRecallDayError> {
    return this.#rawClient.execute(
      {
        method: "GET",
        urlTemplate: this.#servers.default("/api/recalls/today/matches"),
        auth: noneAuth,
        pathParams: [],
        query: [{ name: "shop", value: request.shop, schema: shopSchema }],
        headers: [],
        body: { kind: "empty" },
      },
      {
        success: { kind: "json", schema: recallDaySchema },
        errorFactory: Evidence.NewestRecallDayError,
      },
      options,
    );
  }

  /**
   * One Recall Replay run with all its rows
   *
   * @remarks
   * The rows /replay/{runId} shows. CPSC's public text and the demo shop's item titles, nothing
   * about a buyer.
   *
   * @returns The run.
   *
   * @throws {@link Evidence.ReadReplayError} when the API answers with an error status, narrow on
   * `err.payload.kind`
   *
   * @throws {@link RecallReachPublicApiError} when no usable response was produced: a connection
   * failure, a timeout, a body that would not decode, a value that would not encode, or a
   * credential that could not be obtained
   */
  readReplay(
    request: Evidence.ReadReplayRequest,
    options?: RequestOptions,
  ): ApiPromise<ReplayRun, Evidence.ReadReplayError> {
    return this.#rawClient.execute(
      {
        method: "GET",
        urlTemplate: this.#servers.default("/api/replay/{runId}"),
        auth: noneAuth,
        pathParams: [{ name: "runId", value: request.runId, schema: s.string() }],
        query: [],
        headers: [],
        body: { kind: "empty" },
      },
      {
        success: { kind: "json", schema: replayRunSchema },
        errorFactory: Evidence.ReadReplayError,
      },
      options,
    );
  }

  /**
   * Recount a Recall Replay's headline numbers from its own rows
   *
   * @remarks
   * Works the counts out again from the run's stored rows and compares them with the numbers it
   * reported.
   *
   * @returns The stored numbers, the recount, and whether CPSC's records are still the ones it
   * read.
   *
   * @throws {@link Evidence.RecountReplayError} when the API answers with an error status, narrow
   * on `err.payload.kind`
   *
   * @throws {@link RecallReachPublicApiError} when no usable response was produced: a connection
   * failure, a timeout, a body that would not decode, a value that would not encode, or a
   * credential that could not be obtained
   */
  recountReplay(
    request: Evidence.RecountReplayRequest,
    options?: RequestOptions,
  ): ApiPromise<Proof, Evidence.RecountReplayError> {
    return this.#rawClient.execute(
      {
        method: "GET",
        urlTemplate: this.#servers.default("/api/proof/{runId}"),
        auth: noneAuth,
        pathParams: [{ name: "runId", value: request.runId, schema: s.string() }],
        query: [],
        headers: [],
        body: { kind: "empty" },
      },
      {
        success: { kind: "json", schema: proofSchema },
        errorFactory: Evidence.RecountReplayError,
      },
      options,
    );
  }
}

export namespace Evidence {
  export type NewestRecallDayRequest = {
    /** Only the demo shop is public. */
    shop: Shop;
  };

  export class NewestRecallDayError extends ApiError {
    declare readonly payload: Declared<"problem", Problem> | Declared<"problem2", Problem> | Undeclared;

    static readonly errors: ErrorDecoders<NewestRecallDayError> = [
      { on: 400, kind: "problem", decode: { kind: "json", schema: problemSchema } },
      { on: 404, kind: "problem2", decode: { kind: "json", schema: problemSchema } },
    ];
  }

  export type ReadReplayRequest = {
    runId: string;
  };

  export class ReadReplayError extends ApiError {
    declare readonly payload: Declared<"problem", Problem> | Undeclared;

    static readonly errors: ErrorDecoders<ReadReplayError> = [
      { on: 404, kind: "problem", decode: { kind: "json", schema: problemSchema } },
    ];
  }

  export type RecountReplayRequest = {
    runId: string;
  };

  export class RecountReplayError extends ApiError {
    declare readonly payload: Declared<"problem", Problem> | Undeclared;

    static readonly errors: ErrorDecoders<RecountReplayError> = [
      { on: 404, kind: "problem", decode: { kind: "json", schema: problemSchema } },
    ];
  }
}
