import type { CoreClientOptions } from "./core/client-options.js";

export type ClientOptions = SdkClientOptions & CoreClientOptions;

type SdkClientOptions = ServerOptions;

type ServerOptions = {
  /** The deployed site. Its payments run on PayPal's sandbox. */
  readonly serverOptions?: {
    baseUrl?: string;
  };
};
