<!-- Generated file — do not edit; regenerated with the SDK. -->

# Status — operations

Accessor: `client.status` · Source: `src/resources/status.ts` · 2 operations · Request and error types: namespace `Status`

**Type sources**: every type an operation names, with the file that declares it and the schema value exported beside it. Import every name from `recall-reach-public-api`; the `Source` path is where to **read** the shape, never what to import. `ApiError`, the runtime error family and the file vocabulary are excluded — see sdk-map.md.

### health

- **Signature**: `health(options?: RequestOptions): ApiPromise<Health, Status.HealthError>`
- **Wire**: `GET /api/health`
- **Auth**: none — public; no credential is sent
- **Request body**: none — no `Content-Type` header is sent
- **Returns**: `Health`
- **Error**: `RecallReachPublicApiError` with `kind: "api"`, an instance of `Status.HealthError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"healthDown"` [503] `HealthDown` · `"undeclared"` [any other] `rawBody: ArrayBuffer`

| Type | Schema value | Source |
| --- | --- | --- |
| `Health` | `healthSchema` | `src/models/health.ts` |
| `HealthDown` | `healthDownSchema` | `src/models/health-down.ts` |

### live

- **Signature**: `live(options?: RequestOptions): ApiPromise<undefined, ApiError>`
- **Wire**: `GET /api/live`
- **Auth**: none — public; no credential is sent
- **Request body**: none — no `Content-Type` header is sent
- **Returns**: `undefined` — the operation resolves to nothing
- **Error**: `RecallReachPublicApiError` with `kind: "api"` — untyped, `payload.kind` always `"undeclared"`

