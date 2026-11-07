# What the APIMatic Context Plugin did here

The [PayPal Server SDK context plugin](https://github.com/paypaldev/server-sdk-context-plugin-preview) teaches a coding agent the APIMatic-generated `@paypal/paypal-server-sdk`. It was used for one thing: moving the refund read in `server/paypal/sdkRefundRead.ts` onto that SDK. Sending a refund stays on the PayPal Agent Toolkit.

Its eight TypeScript skills were copied into this project only. Its files are Markdown, so nothing had to run to use them.

Separately, APIMatic's CLI generated a TypeScript SDK and a docs portal from our own [`openapi.yaml`](../openapi.yaml), on Nov 7, 2026: the SDK is in [`sdk/typescript`](../sdk/typescript), and the portal is static files in `public/api-docs`, served at [`/api-docs`](https://recall-reach-web-e022.onrender.com/api-docs) by this site, so it doesn't depend on an APIMatic account staying open. Its settings are in [`apimatic/apimatic.json`](../apimatic/apimatic.json). `scripts/sdk.test.ts` checks the SDK's models read what the real routes answer, and `scripts/sdk-live.ts` calls the deployed site through it. Validating the spec first found six errors, all missing descriptions and a YAML quoting slip, which were fixed in the spec itself.

To generate them again, with an APIMatic login: put `openapi.yaml` in `src/spec/` and `apimatic.json` in `src/` of an empty folder, then run `apimatic api validate --file src/spec/openapi.yaml`, `apimatic sdk generate -l typescript -i .` and `apimatic portal generate -i .` there.

## What it changed

Each of these came from reading the skill, then checking the SDK's source at 2.5.0.

- **A real timeout.** The skill warns that the generated default is commonly `0`, which reaches axios as no limit, and that the adapter's own default doesn't apply to a `0`. `DEFAULT_CONFIGURATION` in 2.5.0 is `timeout: 0`. We set 30 seconds. A test fails if the default comes back.
- **No second layer of retries.** The skill says retry layers multiply. `DEFAULT_RETRY_CONFIG` in 2.5.0 has `maxNumberOfRetries: 0` and `maximumRetryWaitTime: 0`, so retries are off unless both change. Our client already retries a GET, so they stay off, and a test checks that a 503 makes one call.
- **No token exchange inside the SDK.** The skill says neither a signal nor a timeout reaches a token exchange. So the SDK gets the token the app already holds, with an expiry ahead of it, and never asks for its own. A test checks that one read makes one network call.
- **Errors read from the right field.** The skill says a bare `ApiError` never fills `result`, only `body`. So the read passes `statusCode` and the raw `body` up, and our client treats PayPal's answer the way it treats any other.
- **No base URL to get wrong.** The skill says there is no free-form base URL, only `Environment`. We use `Environment.Sandbox`.

## What it didn't catch

It found nothing wrong in code we already had. Our own PayPal client already had a 60-second limit per attempt and a 30-second limit on the token call. We had already found the Agent Toolkit's missing timeout by testing it, and the skills don't cover the toolkit.

## Where we went against it

The testing skill suggests a stub axios adapter, and warns against owning the transport. We set axios's built-in `fetch` adapter through `unstable_httpClientOptions`, so this call uses the same fetch as every other PayPal call. Tests replace only the network. That option is marked unstable, so the SDK's version is pinned exactly.

## What it didn't help with

Verifying webhooks, reading sales across Transaction Search windows, PayPal's 48-hour deletion rule, matching recalls and the refund send. Those are all outside what the SDK covers.

This is one read-only call. It isn't a migration to the SDK.
