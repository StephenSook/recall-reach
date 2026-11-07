# One Recall Replay run with all its rows (/api-docs/api/openapi/evidence/readReplay)

`GET /api/replay/{runId}`

The rows /replay/{runId} shows. CPSC's public text and the demo shop's item titles, nothing about a buyer.

```yaml
openapi: 3.2.0
servers:
  - url: https://recall-reach-web-e022.onrender.com
    description: The deployed site. Its payments run on PayPal's sandbox.
paths:
  /api/replay/{runId}:
    get:
      tags:
        - Evidence
      operationId: readReplay
      summary: One Recall Replay run with all its rows
      description: The rows /replay/{runId} shows. CPSC's public text and the demo
        shop's item titles, nothing about a buyer.
      parameters:
        - name: runId
          in: path
          required: true
          schema:
            type: string
            format: uuid
      responses:
        "200":
          description: The run.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ReplayRun"
        "404":
          description: No such run. Runs are pruned, so an old id can stop working.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Problem"
      x-apimatic-codeSamples:
        - lang: typescript
          label: TypeScript
          sources:
            Example: >-
              try {
                const response = await client.evidence.readReplay({
                  runId: "00000000-0000-0000-0000-000000000000",
                });
                // TODO: Handle 'response' of type ReplayRun
              } catch (err) {
                // TODO: Handle 'err' of type Evidence.ReadReplayError, discriminated with 'err.payload.kind'
              }
components:
  schemas:
    ReplayRun:
      type: object
      required:
        - runId
        - ms
        - createdAt
        - counts
        - search
        - recallYearsMissing
        - rows
      properties:
        runId:
          type: string
          format: uuid
        ms:
          type: integer
        createdAt:
          type: string
          format: date-time
        counts:
          type: object
        search:
          type: object
        recallYearsMissing:
          type: array
          items:
            type: integer
        rows:
          type: array
          items:
            type: object
            required:
              - recallNumber
              - recallTitle
              - recallDate
              - outcome
            properties:
              recallNumber:
                type: string
              recallTitle:
                type: string
              recallDate:
                type: string
              outcome:
                type: string
                enum:
                  - MATCH
                  - SCOPE_GAP
                  - CLEARED
                  - NOT_NEAR
              saleSplit:
                type:
                  - string
                  - "null"
              itemTitle:
                type:
                  - string
                  - "null"
              reason:
                type:
                  - string
                  - "null"
    Problem:
      type: object
      required:
        - error
      properties:
        error:
          type: string
info:
  title: Recall Reach public API
  version: 1.0.0
```