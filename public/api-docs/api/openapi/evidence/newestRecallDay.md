# The newest day of recalls in the latest Recall Replay, against the demo shop (/api-docs/api/openapi/evidence/newestRecallDay)

`GET /api/recalls/today/matches`

Read from the latest stored Recall Replay run, so it costs no new check. Only the demo shop is public.

```yaml
openapi: 3.2.0
servers:
  - url: https://recall-reach-web-e022.onrender.com
    description: The deployed site. Its payments run on PayPal's sandbox.
paths:
  /api/recalls/today/matches:
    get:
      tags:
        - Evidence
      operationId: newestRecallDay
      summary: The newest day of recalls in the latest Recall Replay, against the demo
        shop
      description: Read from the latest stored Recall Replay run, so it costs no new
        check. Only the demo shop is public.
      parameters:
        - name: shop
          in: query
          required: true
          description: Only the demo shop is public.
          schema:
            type: string
            enum:
              - demo
      responses:
        "200":
          description: That day's recalls and what each one found.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/RecallDay"
        "400":
          description: A shop other than the demo shop.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Problem"
        "404":
          description: No Recall Replay has run yet.
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
                const response = await client.evidence.newestRecallDay({
                  shop: Shop.Demo,
                });
                // TODO: Handle 'response' of type RecallDay
              } catch (err) {
                // TODO: Handle 'err' of type Evidence.NewestRecallDayError, discriminated with 'err.payload.kind'
              }
components:
  schemas:
    RecallDay:
      type: object
      required:
        - shop
        - runId
        - recallDate
        - recalls
      properties:
        shop:
          type: string
        runId:
          type: string
          format: uuid
        recallDate:
          type:
            - string
            - "null"
          format: date
        recalls:
          type: array
          items:
            type: object
            required:
              - recallNumber
              - recallTitle
              - outcome
            properties:
              recallNumber:
                type: string
              recallTitle:
                type: string
              outcome:
                type: string
                enum:
                  - MATCH
                  - SCOPE_GAP
                  - CLEARED
                  - NOT_NEAR
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