# Check a product title or model against CPSC recalls (/api-docs/api/openapi/check/checkRecall)

`GET /api/check`

Runs the rules a shop's sales get on the text you send. Our code doesn't store or log it. It travels in the page address, so the web host's request logs may include it. At least one of title and model is needed. Limited to 60 checks an hour per visitor.

```yaml
openapi: 3.2.0
servers:
  - url: https://recall-reach-web-e022.onrender.com
    description: The deployed site. Its payments run on PayPal's sandbox.
paths:
  /api/check:
    get:
      tags:
        - Check
      operationId: checkRecall
      summary: Check a product title or model against CPSC recalls
      description: Runs the rules a shop's sales get on the text you send. Our code
        doesn't store or log it. It travels in the page address, so the web
        host's request logs may include it. At least one of title and model is
        needed. Limited to 60 checks an hour per visitor.
      parameters:
        - name: title
          in: query
          description: The product's title, as a listing or a label would say it.
          schema:
            type: string
            maxLength: 200
          examples:
            default:
              value: Baby Brezza sterilizer
        - name: model
          in: query
          description: The model number, if you have one. Compared with the models CPSC
            names.
          schema:
            type: string
            maxLength: 60
          examples:
            default:
              value: BRZ0083
      responses:
        "200":
          description: "The recalls this text comes near, closest first. An empty list
            isn't the same as nothing near: read mentioned too."
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/CheckAnswer"
        "400":
          description: No usable text, or too much of it.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Problem"
        "429":
          description: Too many checks. Try again in an hour.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Problem"
        "503":
          description: The check could not run just now.
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
                const response = await client.check.checkRecall({
                  title: "Baby Brezza sterilizer",
                  model: "BRZ0083",
                });
                // TODO: Handle 'response' of type CheckAnswer
              } catch (err) {
                // TODO: Handle 'err' of type Check.CheckRecallError, discriminated with 'err.payload.kind'
              }
components:
  schemas:
    CheckAnswer:
      type: object
      required:
        - results
        - more
        - cleared
        - notJudged
        - mentioned
        - checked
        - note
      properties:
        results:
          type: array
          items:
            $ref: "#/components/schemas/CheckResult"
        more:
          type: integer
          description: Recalls found past the ones listed.
        cleared:
          type: integer
          description: Recalls that came near and were ruled out, so they aren't listed.
        notJudged:
          type: integer
          description: Recalls that came near but weren't judged, because too many did.
            Above zero, an empty list doesn't mean nothing was found.
        mentioned:
          type: object
          description: Past the results, recalls whose text has what was given. A maker or
            a product word given alone ends up here, so an empty results list
            isn't the same as nothing near. Only looked for when no recall is
            tied to the text.
          required:
            - recalls
            - total
          properties:
            total:
              type: integer
            recalls:
              type: array
              items:
                type: object
                required:
                  - recallNumber
                  - title
                properties:
                  recallNumber:
                    type: string
                  title:
                    type: string
        checked:
          type: object
          required:
            - recalls
            - yearsMissing
          properties:
            recalls:
              type: integer
            from:
              type:
                - string
                - "null"
              format: date
            to:
              type:
                - string
                - "null"
              format: date
            yearsMissing:
              type: array
              description: Years whose recalls didn't fully load, so this answer may not cover
                them.
              items:
                type: integer
        note:
          type: string
    Problem:
      type: object
      required:
        - error
      properties:
        error:
          type: string
    CheckResult:
      type: object
      required:
        - recallNumber
        - title
        - recallDate
        - verdict
        - strength
        - tiedToRecall
        - sharesWords
        - reason
        - missing
      properties:
        recallNumber:
          type: string
        title:
          type: string
        recallDate:
          type: string
          format: date
        url:
          type:
            - string
            - "null"
        verdict:
          type: string
          enum:
            - MATCH
            - SCOPE_GAP
          description: MATCH means the text shows what the recall names. SCOPE_GAP means
            it comes close to what the recall names, but the text can't show
            this item is covered.
        strength:
          type: string
        tiedToRecall:
          type: boolean
          description: The text has this recall's model, a code close to it, or its maker
            and product line. Otherwise it only shares a kind of product.
        sharesWords:
          type: boolean
          description: Its text has what was given, all of it or a word few recalls have,
            so it could be this item. Otherwise it only shares a kind of
            product. Only set when no recall is tied to the text.
        reason:
          type: string
        missing:
          type: array
          description: What it would take to settle a SCOPE_GAP verdict.
          items:
            type: string
info:
  title: Recall Reach public API
  version: 1.0.0
```