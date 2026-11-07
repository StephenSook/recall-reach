<!-- Generated file, do not edit; regenerated with the SDK. -->

# Evidence, operations

Accessor: `client.evidence` · Source: `src/resources/evidence.ts` · 3 operations · Request and error types: namespace `Evidence`

**Type sources**: every type an operation names, with the file that declares it and the schema value exported beside it. Import every name from `recall-reach-public-api`; the `Source` path is where to **read** the shape, never what to import. `ApiError`, the runtime error family and the file vocabulary are excluded, see sdk-map.md.

### newestRecallDay

- **Signature**: `newestRecallDay(request: Evidence.NewestRecallDayRequest, options?: RequestOptions): ApiPromise<RecallDay, Evidence.NewestRecallDayError>`
- **Wire**: `GET /api/recalls/today/matches`
- **Auth**: none, public; no credential is sent
- **Request body**: none, no `Content-Type` header is sent
- **Returns**: `RecallDay`
- **Error**: `RecallReachPublicApiError` with `kind: "api"`, an instance of `Evidence.NewestRecallDayError`, **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"problem"` [400] `Problem` · `"problem2"` [404] `Problem` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

**Fields**, `Evidence.NewestRecallDayRequest` (1):

| Field | Channel | Type | Req |
| --- | --- | --- | --- |
| `shop` | `query` | `Shop` | yes |

| Type | Schema value | Source |
| --- | --- | --- |
| `Shop` | `shopSchema` | `src/models/shop.ts` |
| `RecallDay` | `recallDaySchema` | `src/models/recall-day.ts` |
| `Problem` | `problemSchema` | `src/models/problem.ts` |

### readReplay

- **Signature**: `readReplay(request: Evidence.ReadReplayRequest, options?: RequestOptions): ApiPromise<ReplayRun, Evidence.ReadReplayError>`
- **Wire**: `GET /api/replay/{runId}`
- **Auth**: none, public; no credential is sent
- **Request body**: none, no `Content-Type` header is sent
- **Returns**: `ReplayRun`
- **Error**: `RecallReachPublicApiError` with `kind: "api"`, an instance of `Evidence.ReadReplayError`, **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"problem"` [404] `Problem` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

**Fields**, `Evidence.ReadReplayRequest` (1):

| Field | Channel | Type | Req |
| --- | --- | --- | --- |
| `runId` | `path` | `string` | yes |

| Type | Schema value | Source |
| --- | --- | --- |
| `ReplayRun` | `replayRunSchema` | `src/models/replay-run.ts` |
| `Problem` | `problemSchema` | `src/models/problem.ts` |

### recountReplay

- **Signature**: `recountReplay(request: Evidence.RecountReplayRequest, options?: RequestOptions): ApiPromise<Proof, Evidence.RecountReplayError>`
- **Wire**: `GET /api/proof/{runId}`
- **Auth**: none, public; no credential is sent
- **Request body**: none, no `Content-Type` header is sent
- **Returns**: `Proof`
- **Error**: `RecallReachPublicApiError` with `kind: "api"`, an instance of `Evidence.RecountReplayError`, **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"problem"` [404] `Problem` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

**Fields**, `Evidence.RecountReplayRequest` (1):

| Field | Channel | Type | Req |
| --- | --- | --- | --- |
| `runId` | `path` | `string` | yes |

| Type | Schema value | Source |
| --- | --- | --- |
| `Proof` | `proofSchema` | `src/models/proof.ts` |
| `Problem` | `problemSchema` | `src/models/problem.ts` |

