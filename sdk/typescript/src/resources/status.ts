import { ApiError, type Declared, type Undeclared } from "../core/api-error.js";
import type { ApiPromise } from "../core/api-promise.js";
import type { RequestOptions } from "../core/api-request.js";
import { noneAuth } from "../core/auth/schemes.js";
import type { RawClient } from "../core/raw-client.js";
import type { ErrorDecoders } from "../core/response-decoder.js";
import { healthDownSchema, type HealthDown } from "../models/health-down.js";
import { healthSchema, type Health } from "../models/health.js";
import type { Servers } from "../servers.js";

export class Status {
  readonly #rawClient: RawClient;
  readonly #servers: Servers;

  constructor(rawClient: RawClient, servers: Servers) {
    this.#rawClient = rawClient;
    this.#servers = servers;
  }

  /**
   * Whether the site is working, check by check
   *
   * @remarks
   * Each check and the reading behind it. Never includes a secret or a database error's text.
   *
   * @returns Every check passed, or only CPSC is failing. Then ok is false and degraded names it,
   * since this site still works from the recalls it holds.
   *
   * @throws {@link Status.HealthError} when the API answers with an error status, narrow on
   * `err.payload.kind`
   *
   * @throws {@link RecallReachPublicApiError} when no usable response was produced: a connection
   * failure, a timeout, a body that would not decode, a value that would not encode, or a
   * credential that could not be obtained
   */
  health(options?: RequestOptions): ApiPromise<Health, Status.HealthError> {
    return this.#rawClient.execute(
      {
        method: "GET",
        urlTemplate: this.#servers.default("/api/health"),
        auth: noneAuth,
        pathParams: [],
        query: [],
        headers: [],
        body: { kind: "empty" },
      },
      {
        success: { kind: "json", schema: healthSchema },
        errorFactory: Status.HealthError,
      },
      options,
    );
  }

  /**
   * Whether the server answers. Touches no database.
   *
   * @remarks
   * For the host's health check. It says only that the server is up.
   *
   * @returns It answers.
   *
   * @throws {@link ApiError} when the API answers with an error status
   *
   * @throws {@link RecallReachPublicApiError} when no usable response was produced: a connection
   * failure, a timeout, a body that would not decode, a value that would not encode, or a
   * credential that could not be obtained
   */
  live(options?: RequestOptions): ApiPromise<undefined, ApiError> {
    return this.#rawClient.execute(
      {
        method: "GET",
        urlTemplate: this.#servers.default("/api/live"),
        auth: noneAuth,
        pathParams: [],
        query: [],
        headers: [],
        body: { kind: "empty" },
      },
      {
        success: { kind: "empty" },
        errorFactory: ApiError,
      },
      options,
    );
  }
}

export namespace Status {
  export class HealthError extends ApiError {
    declare readonly payload: Declared<"healthDown", HealthDown> | Undeclared;

    static readonly errors: ErrorDecoders<HealthError> = [
      { on: 503, kind: "healthDown", decode: { kind: "json", schema: healthDownSchema } },
    ];
  }
}
