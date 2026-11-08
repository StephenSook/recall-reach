<!-- Generated file, do not edit; regenerated with the SDK. -->

# Check, operations

Accessor: `client.check` · Source: `src/resources/check.ts` · 4 operations · Request and error types: namespace `Check`

**Type sources**: every type an operation names, with the file that declares it and the schema value exported beside it. Import every name from `recall-reach-public-api`; the `Source` path is where to **read** the shape, never what to import. `ApiError`, the runtime error family and the file vocabulary are excluded, see sdk-map.md.

### checkRecall

- **Signature**: `checkRecall(request?: Check.CheckRecallRequest, options?: RequestOptions): ApiPromise<CheckAnswer, Check.CheckRecallError>`
- **Wire**: `GET /api/check`
- **Auth**: none, public; no credential is sent
- **Request body**: none, no `Content-Type` header is sent
- **Returns**: `CheckAnswer`
- **Error**: `RecallReachPublicApiError` with `kind: "api"`, an instance of `Check.CheckRecallError`, **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"problem"` [400] `Problem` · `"problem2"` [429] `Problem` · `"problem3"` [503] `Problem` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

**Fields**, `Check.CheckRecallRequest` (2):

| Field | Channel | Type | Req |
| --- | --- | --- | --- |
| `title` | `query` | `string` | no |
| `model` | `query` | `string` | no |

| Type | Schema value | Source |
| --- | --- | --- |
| `CheckAnswer` | `checkAnswerSchema` | `src/models/check-answer.ts` |
| `Problem` | `problemSchema` | `src/models/problem.ts` |

### mcp

- **Signature**: `mcp(request: Check.McpRequest, options?: RequestOptions): ApiPromise<Record<string, unknown>, Check.McpError>`
- **Wire**: `POST /api/mcp`
- **Auth**: none, public; no credential is sent
- **Request body**: `application/json`, the `body` field
- **SDK-sent**: `header Idempotency-Key` (minted per call)
- **Returns**: `Record<string, unknown>`, a bare `application/json` map; the success type *is* the map
- **Error**: `RecallReachPublicApiError` with `kind: "api"`, an instance of `Check.McpError`, **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"problem"` [413] `Problem` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

**Fields**, `Check.McpRequest` (1):

| Field | Channel | Type | Req |
| --- | --- | --- | --- |
| `body` | `body` | `ApiMcpRequest` | yes |

| Type | Schema value | Source |
| --- | --- | --- |
| `ApiMcpRequest` | `apiMcpRequestSchema` | `src/models/api-mcp-request.ts` |
| `Problem` | `problemSchema` | `src/models/problem.ts` |

### mcpNoStream

- **Signature**: `mcpNoStream(options?: RequestOptions): ApiPromise<undefined, Check.McpNoStreamError>`
- **Wire**: `GET /api/mcp`
- **Auth**: none, public; no credential is sent
- **Request body**: none, no `Content-Type` header is sent
- **Returns**: `undefined`, the operation resolves to nothing
- **Error**: `RecallReachPublicApiError` with `kind: "api"`, an instance of `Check.McpNoStreamError`, **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"problem"` [405] `Problem` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

| Type | Schema value | Source |
| --- | --- | --- |
| `Problem` | `problemSchema` | `src/models/problem.ts` |

### readRecall

- **Signature**: `readRecall(request: Check.ReadRecallRequest, options?: RequestOptions): ApiPromise<PublicRecall, Check.ReadRecallError>`
- **Wire**: `GET /api/recalls/{recallNumber}`
- **Auth**: none, public; no credential is sent
- **Request body**: none, no `Content-Type` header is sent
- **Returns**: `PublicRecall`
- **Error**: `RecallReachPublicApiError` with `kind: "api"`, an instance of `Check.ReadRecallError`, **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"problem"` [400] `Problem` · `"problem2"` [404] `Problem` · `"problem3"` [429] `Problem` · `"problem4"` [503] `Problem` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

**Fields**, `Check.ReadRecallRequest` (1):

| Field | Channel | Type | Req |
| --- | --- | --- | --- |
| `recallNumber` | `path` | `string` | yes |

| Type | Schema value | Source |
| --- | --- | --- |
| `PublicRecall` | `publicRecallSchema` | `src/models/public-recall.ts` |
| `Problem` | `problemSchema` | `src/models/problem.ts` |

