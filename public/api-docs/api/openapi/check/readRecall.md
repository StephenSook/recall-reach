# Read one CPSC recall by its number (/api-docs/api/openapi/check/readRecall)

`GET /api/recalls/{recallNumber}`

The same public record get_recall returns. No key, no cookie, and no shop or buyer data. Shares /api/check's limit of 60 checks an hour per visitor. Responses use no-store and allow any origin.

```yaml
openapi: 3.2.0
servers:
  - url: https://recall-reach-web-e022.onrender.com
    description: The deployed site. Its payments run on PayPal's sandbox.
paths:
  /api/recalls/{recallNumber}:
    get:
      tags:
        - Check
      operationId: readRecall
      summary: Read one CPSC recall by its number
      description: The same public record get_recall returns. No key, no cookie, and
        no shop or buyer data. Shares /api/check's limit of 60 checks an hour
        per visitor. Responses use no-store and allow any origin.
      parameters:
        - name: recallNumber
          in: path
          required: true
          description: The recall number, as /api/check gives it.
          schema:
            type: string
            minLength: 1
            maxLength: 16
            pattern: ^[A-Za-z0-9-]{1,16}$
          examples:
            default:
              value: "27072"
      responses:
        "200":
          description: CPSC's public record, including its photo if one is held.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/PublicRecall"
        "400":
          description: That isn't a recall number.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Problem"
        "404":
          description: No such recall is held here. This does not mean a product is safe.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Problem"
        "429":
          description: Too many checks. Try again in an hour.
          headers:
            Retry-After:
              description: Seconds before trying again.
              schema:
                type: integer
                enum:
                  - 3600
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Problem"
        "503":
          description: The recall could not be read just now.
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
                const response = await client.check.readRecall({
                  recallNumber: "27072",
                });
                // TODO: Handle 'response' of type PublicRecall
              } catch (err) {
                // TODO: Handle 'err' of type Check.ReadRecallError, discriminated with 'err.payload.kind'
              }
components:
  schemas:
    PublicRecall:
      type: object
      additionalProperties: false
      required:
        - found
        - recallNumber
        - title
        - recallDate
        - url
        - description
        - products
        - hazards
        - remedies
        - image
      properties:
        found:
          type: boolean
          enum:
            - true
        recallNumber:
          type: string
          examples:
            - "27072"
        title:
          type: string
        recallDate:
          type: string
          format: date
        url:
          type: string
        description:
          type: string
        products:
          type: array
          items:
            type: object
            required:
              - name
              - model
              - type
              - units
            properties:
              name:
                type: string
              model:
                type: string
              type:
                type:
                  - string
                  - "null"
              units:
                type:
                  - string
                  - "null"
        hazards:
          type: array
          items:
            type: string
        remedies:
          type: array
          items:
            type: string
        image:
          type:
            - object
            - "null"
          required:
            - url
            - caption
          properties:
            url:
              type: string
            caption:
              type: string
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