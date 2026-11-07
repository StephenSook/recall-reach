# Reference

> Source: [RecallReachPublicApiClient](src/client.ts)

## Check

> Source: [Check](src/resources/check.ts)

<details>
<summary><code>checkRecall(request?: Check.CheckRecallRequest, options?: RequestOptions): ApiPromise&lt;CheckAnswer, Check.CheckRecallError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

Runs the rules a shop's sales get on the text you send. Our code doesn't store or log it. It travels in the page address, so the web host's request logs may include it. At least one of title and model is needed. Limited to 60 checks an hour per visitor.

</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  const response = await client.check.checkRecall({ title: "Baby Brezza sterilizer", model: "BRZ0083" });
  // TODO: Handle 'response' of type CheckAnswer
} catch (err) {
  // TODO: Handle 'err' of type Check.CheckRecallError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.check.checkRecall({
  title: "Baby Brezza sterilizer",
  model: "BRZ0083",
}).asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: Use 'result.value' of type CheckAnswer
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Parameters

<dl>
<dd>

| Name | Type | Description |
| --- | --- | --- |
| <code>title?</code> | <code>string</code> | The product's title, as a listing or a label would say it. |
| <code>model?</code> | <code>string</code> | The model number, if you have one. Compared with the models CPSC names. |

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.check.checkRecall(request)`

- **OnSuccess**: <code>[CheckAnswer](src/models/check-answer.ts)</code>
- **OnError**: throws <code>[Check.CheckRecallError](src/resources/check.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.check.checkRecall(request).asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;CheckAnswer, Check.CheckRecallError&gt;</code>, with `result.value` of type <code>[CheckAnswer](src/models/check-answer.ts)</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[RecallReachPublicApiError](src/core/errors.ts)</code> on any operational failure, a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

<details>
<summary><code>mcp(request: Check.McpRequest, options?: RequestOptions): ApiPromise&lt;Record&lt;string, unknown&gt;, Check.McpError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

Two read-only tools: check_recall(title, model), and get_recall(recallNumber), which gives one recall's CPSC text. Stateless: each request stands alone. Send JSON-RPC 2.0, with Accept application/json, text/event-stream. It shares the limit of /api/check.

</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  const response = await client.check.mcp({
    body: { jsonrpc: "some example string", method: "some example string" },
  });
  // TODO: Handle 'response' of type Record<string, unknown>
} catch (err) {
  // TODO: Handle 'err' of type Check.McpError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.check.mcp({
  body: { jsonrpc: "some example string", method: "some example string" },
}).asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: Use 'result.value' of type Record<string, unknown>
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Parameters

<dl>
<dd>

| Name | Type | Description |
| --- | --- | --- |
| <code>body</code> | <code>[ApiMcpRequest](src/models/api-mcp-request.ts)</code> | - |

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.check.mcp(request)`

- **OnSuccess**: <code>Record&lt;string, unknown&gt;</code>
- **OnError**: throws <code>[Check.McpError](src/resources/check.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.check.mcp(request).asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;Record&lt;string, unknown&gt;, Check.McpError&gt;</code>, with `result.value` of type <code>Record&lt;string, unknown&gt;</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[RecallReachPublicApiError](src/core/errors.ts)</code> on any operational failure, a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

<details>
<summary><code>mcpNoStream(options?: RequestOptions): ApiPromise&lt;undefined, Check.McpNoStreamError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

The server is stateless and opens no event stream, so a GET is refused with 405.

</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  await client.check.mcpNoStream();
} catch (err) {
  // TODO: Handle 'err' of type Check.McpNoStreamError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.check.mcpNoStream().asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: The call succeeded and resolves to no body
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.check.mcpNoStream()`

- **OnSuccess**: <code>undefined</code>
- **OnError**: throws <code>[Check.McpNoStreamError](src/resources/check.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.check.mcpNoStream().asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;undefined, Check.McpNoStreamError&gt;</code>, with `result.value` of type <code>undefined</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[RecallReachPublicApiError](src/core/errors.ts)</code> on any operational failure, a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

## Evidence

> Source: [Evidence](src/resources/evidence.ts)

<details>
<summary><code>newestRecallDay(request: Evidence.NewestRecallDayRequest, options?: RequestOptions): ApiPromise&lt;RecallDay, Evidence.NewestRecallDayError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

Read from the latest stored Recall Replay run, so it costs no new check. Only the demo shop is public.

</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  const response = await client.evidence.newestRecallDay({ shop: Shop.Demo });
  // TODO: Handle 'response' of type RecallDay
} catch (err) {
  // TODO: Handle 'err' of type Evidence.NewestRecallDayError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.evidence.newestRecallDay({ shop: Shop.Demo }).asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: Use 'result.value' of type RecallDay
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Parameters

<dl>
<dd>

| Name | Type | Description |
| --- | --- | --- |
| <code>shop</code> | <code>[Shop](src/models/shop.ts)</code> | Only the demo shop is public. |

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.evidence.newestRecallDay(request)`

- **OnSuccess**: <code>[RecallDay](src/models/recall-day.ts)</code>
- **OnError**: throws <code>[Evidence.NewestRecallDayError](src/resources/evidence.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.evidence.newestRecallDay(request).asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;RecallDay, Evidence.NewestRecallDayError&gt;</code>, with `result.value` of type <code>[RecallDay](src/models/recall-day.ts)</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[RecallReachPublicApiError](src/core/errors.ts)</code> on any operational failure, a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

<details>
<summary><code>readReplay(request: Evidence.ReadReplayRequest, options?: RequestOptions): ApiPromise&lt;ReplayRun, Evidence.ReadReplayError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

The rows /replay/{runId} shows. CPSC's public text and the demo shop's item titles, nothing about a buyer.

</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  const response = await client.evidence.readReplay({ runId: "00000000-0000-0000-0000-000000000000" });
  // TODO: Handle 'response' of type ReplayRun
} catch (err) {
  // TODO: Handle 'err' of type Evidence.ReadReplayError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.evidence.readReplay({
  runId: "00000000-0000-0000-0000-000000000000",
}).asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: Use 'result.value' of type ReplayRun
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Parameters

<dl>
<dd>

| Name | Type | Description |
| --- | --- | --- |
| <code>runId</code> | <code>string</code> | - |

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.evidence.readReplay(request)`

- **OnSuccess**: <code>[ReplayRun](src/models/replay-run.ts)</code>
- **OnError**: throws <code>[Evidence.ReadReplayError](src/resources/evidence.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.evidence.readReplay(request).asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;ReplayRun, Evidence.ReadReplayError&gt;</code>, with `result.value` of type <code>[ReplayRun](src/models/replay-run.ts)</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[RecallReachPublicApiError](src/core/errors.ts)</code> on any operational failure, a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

<details>
<summary><code>recountReplay(request: Evidence.RecountReplayRequest, options?: RequestOptions): ApiPromise&lt;Proof, Evidence.RecountReplayError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

Works the counts out again from the run's stored rows and compares them with the numbers it reported.

</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  const response = await client.evidence.recountReplay({ runId: "00000000-0000-0000-0000-000000000000" });
  // TODO: Handle 'response' of type Proof
} catch (err) {
  // TODO: Handle 'err' of type Evidence.RecountReplayError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.evidence.recountReplay({
  runId: "00000000-0000-0000-0000-000000000000",
}).asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: Use 'result.value' of type Proof
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Parameters

<dl>
<dd>

| Name | Type | Description |
| --- | --- | --- |
| <code>runId</code> | <code>string</code> | - |

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.evidence.recountReplay(request)`

- **OnSuccess**: <code>[Proof](src/models/proof.ts)</code>
- **OnError**: throws <code>[Evidence.RecountReplayError](src/resources/evidence.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.evidence.recountReplay(request).asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;Proof, Evidence.RecountReplayError&gt;</code>, with `result.value` of type <code>[Proof](src/models/proof.ts)</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[RecallReachPublicApiError](src/core/errors.ts)</code> on any operational failure, a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

## Status

> Source: [Status](src/resources/status.ts)

<details>
<summary><code>health(options?: RequestOptions): ApiPromise&lt;Health, Status.HealthError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

Each check and the reading behind it. Never includes a secret or a database error's text.

</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  const response = await client.status.health();
  // TODO: Handle 'response' of type Health
} catch (err) {
  // TODO: Handle 'err' of type Status.HealthError, discriminated with 'err.payload.kind'
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.status.health().asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: Use 'result.value' of type Health
} else {
  // TODO: Handle 'result', discriminated with 'result.payload.kind'
}
```

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.status.health()`

- **OnSuccess**: <code>[Health](src/models/health.ts)</code>
- **OnError**: throws <code>[Status.HealthError](src/resources/status.ts)</code>, with `err.payload` discriminated on `kind`

**As ApiResult**: `await client.status.health().asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;Health, Status.HealthError&gt;</code>, with `result.value` of type <code>[Health](src/models/health.ts)</code>
- **OnError**: `result.payload` discriminated on `kind`, with `result.message`

**Thrown**: <code>[RecallReachPublicApiError](src/core/errors.ts)</code> on any operational failure, a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

<details>
<summary><code>live(options?: RequestOptions): ApiPromise&lt;undefined, ApiError&gt;</code></summary>

<dl>
<dd>

### Description

<dl>
<dd>

For the host's health check. It says only that the server is up.

</dd>
</dl>

### Direct Usage

<dl>
<dd>

```ts
try {
  await client.status.live();
} catch (err) {
  // TODO: Handle 'err' of type ApiError, where 'err.payload' is always the Undeclared arm
}
```

</dd>
</dl>

### Usage as ApiResult

<dl>
<dd>

```ts
const result = await client.status.live().asApiResult();
// TODO: Use 'result.status' and 'result.headers' to read the raw response status and headers
if (result.ok) {
  // TODO: The call succeeded and resolves to no body
} else {
  // TODO: Handle 'result', where 'result.payload' is always the Undeclared arm
}
```

</dd>
</dl>

### Response

<dl>
<dd>

**Direct**: `await client.status.live()`

- **OnSuccess**: <code>undefined</code>
- **OnError**: throws <code>[ApiError](src/core/api-error.ts)</code>, with `err.payload` always the <code>[Undeclared](src/core/api-error.ts)</code> arm

**As ApiResult**: `await client.status.live().asApiResult()`

- **OnSuccess**: <code>[ApiResult](src/core/api-promise.ts)&lt;undefined, ApiError&gt;</code>, with `result.value` of type <code>undefined</code>
- **OnError**: `result.payload` always the <code>[Undeclared](src/core/api-error.ts)</code> arm, with `result.message`

**Thrown**: <code>[RecallReachPublicApiError](src/core/errors.ts)</code> on any operational failure, a caller abort and a programmer error stay outside the family and reach you raw

</dd>
</dl>

</dd>
</dl>

</details>

