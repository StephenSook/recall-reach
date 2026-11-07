# Recount a Recall Replay's headline numbers from its own rows (/api-docs/api/openapi/evidence/recountReplay)

`GET /api/proof/{runId}`

Works the counts out again from the run's stored rows and compares them with the numbers it reported.

```yaml
openapi: 3.2.0
servers:
  - url: https://recall-reach-web-e022.onrender.com
    description: The deployed site. Its payments run on PayPal's sandbox.
paths:
  /api/proof/{runId}:
    get:
      tags:
        - Evidence
      operationId: recountReplay
      summary: Recount a Recall Replay's headline numbers from its own rows
      description: Works the counts out again from the run's stored rows and compares
        them with the numbers it reported.
      parameters:
        - name: runId
          in: path
          required: true
          schema:
            type: string
            format: uuid
      responses:
        "200":
          description: The stored numbers, the recount, and whether CPSC's records are
            still the ones it read.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Proof"
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
                const response = await client.evidence.recountReplay({
                  runId: "00000000-0000-0000-0000-000000000000",
                });
                // TODO: Handle 'response' of type Proof
              } catch (err) {
                // TODO: Handle 'err' of type Evidence.RecountReplayError, discriminated with 'err.payload.kind'
              }
components:
  schemas:
    Proof:
      type: object
      required:
        - runId
        - ranAt
        - stored
        - recomputed
        - agree
        - sameRecalls
        - ms
        - search
        - recallYearsMissing
      properties:
        runId:
          type: string
          format: uuid
        ranAt:
          type: string
          format: date-time
        stored:
          $ref: "#/components/schemas/Counts"
        recomputed:
          $ref: "#/components/schemas/Counts"
        agree:
          type: boolean
        sameRecalls:
          type: boolean
        ms:
          type: integer
        search:
          type: object
          required:
            - windows
            - failedWindows
            - complete
          properties:
            windows:
              type: integer
            failedWindows:
              type: integer
            complete:
              type: boolean
        recallYearsMissing:
          type: array
          items:
            type: integer
    Problem:
      type: object
      required:
        - error
      properties:
        error:
          type: string
    Counts:
      type: object
      required:
        - checked
        - matched
        - scopeGaps
        - cleared
        - notNear
        - noticeOnly
        - refundEligible
      properties:
        checked:
          type: integer
        matched:
          type: integer
        scopeGaps:
          type: integer
        cleared:
          type: integer
        notNear:
          type: integer
        noticeOnly:
          type: integer
        refundEligible:
          type: integer
info:
  title: Recall Reach public API
  version: 1.0.0
```