import type { ClientOptions } from "./client-options.js";
import { buildCoreClientOptions } from "./core/client-options.js";
import { RawClient } from "./core/raw-client.js";
import * as host from "./core/runtime-environment.js";
import * as s from "./core/validation/index.js";
import { Check } from "./resources/check.js";
import { Evidence } from "./resources/evidence.js";
import { Status } from "./resources/status.js";
import { buildServers, type Servers } from "./servers.js";

/**
 * Check text against real CPSC recalls, and recount what the site reports. No key and no cookie.
 * Nothing here reads or returns PayPal data or a shop's data. A result names a recall to read, not
 * a finding about an item.
 */
export class RecallReachPublicApiClient {
  readonly #rawClient: RawClient;
  readonly #servers: Servers;
  #check?: Check;
  #evidence?: Evidence;
  #status?: Status;

  constructor(options: ClientOptions = {}) {
    this.#rawClient = new RawClient({
      ...buildCoreClientOptions(options, "RECALL_REACH_PUBLIC_API_CLIENT_LOG"),
      defaultHeaders: [
        { name: "User-Agent", value: "RecallReachPublicApiClient/1.0.0 TypeScript", schema: s.string() },
        { name: "X-APIMatic-Lang", value: "TypeScript", schema: s.string() },
        { name: "X-APIMatic-Package-Version", value: "1.0.0", schema: s.string() },
        { name: "X-APIMatic-Gen-Version", value: "4.0.0", schema: s.string() },
        { name: "X-APIMatic-OS", value: host.operatingSystem(), schema: s.optional(s.string()) },
        { name: "X-APIMatic-Runtime", value: host.runtimeDescription(), schema: s.optional(s.string()) },
      ],
      defaultQuery: [],
      defaultPathParams: [],
    });

    this.#servers = buildServers(options);
  }

  get check(): Check {
    return (this.#check ??= new Check(this.#rawClient, this.#servers));
  }

  get evidence(): Evidence {
    return (this.#evidence ??= new Evidence(this.#rawClient, this.#servers));
  }

  get status(): Status {
    return (this.#status ??= new Status(this.#rawClient, this.#servers));
  }
}
