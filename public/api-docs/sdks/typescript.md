# TypeScript SDK (/api-docs/sdks/typescript)

[Download SDK](/api-docs/__downloads/sdk/typescript.zip)

## Intro [#intro]

The Recall Reach public API SDK provides access to the Recall Reach public API REST APIs.

Check text against real CPSC recalls, and recount what the site reports. No key and no cookie. Nothing here reads or returns PayPal data or a shop's data. A result names a recall to read, not a finding about an item.

## Installation [#installation]

The SDK compiles to `dist/` before it can be referenced, run its `build` script once in the SDK folder, then add it to your project by path:

```bash
npm install <path-to-sdk>
```

## Quick Start [#quick-start]

Create one client and reuse it. Configure its behaviour through `ClientOptions`.

```ts
import { RecallReachPublicApiClient } from "recall-reach-public-api";

const client = new RecallReachPublicApiClient({});
```

Nothing in `ClientOptions` is required, `new RecallReachPublicApiClient()` compiles, and each option left out falls back to its default. This API declares one environment, so there is no environment to select and no host to state at the construction site.

### From CommonJS [#from-commonjs]

The package ships both dialects from a single entry, so `require` works with full types. In a TypeScript CommonJS file use the `import ... = require(...)` form, a plain destructuring `require` runs fine but gives you `any`.

```ts
import sdk = require("recall-reach-public-api");

const client = new sdk.RecallReachPublicApiClient({});
```