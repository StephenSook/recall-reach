# Whether the site is working, check by check (/api-docs/api/openapi/status/health)

`GET /api/health`

Each check and the reading behind it. Never includes a secret or a database error's text.

```yaml
openapi: 3.2.0
servers:
  - url: https://recall-reach-web-e022.onrender.com
    description: The deployed site. Its payments run on PayPal's sandbox.
paths:
  /api/health:
    get:
      tags:
        - Status
      operationId: health
      summary: Whether the site is working, check by check
      description: Each check and the reading behind it. Never includes a secret or a
        database error's text.
      responses:
        "200":
          description: Every check passed, or only CPSC is failing. Then ok is false and
            degraded names it, since this site still works from the recalls it
            holds.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Health"
        "503":
          description: At least one check failed, or the database can't be reached.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/HealthDown"
      x-apimatic-codeSamples:
        - lang: typescript
          label: TypeScript
          sources:
            Example: >-
              try {
                const response = await client.status.health();
                // TODO: Handle 'response' of type Health
              } catch (err) {
                // TODO: Handle 'err' of type Status.HealthError, discriminated with 'err.payload.kind'
              }
components:
  schemas:
    Health:
      type: object
      required:
        - ok
        - checkedAt
        - checks
        - database
        - market
        - integrations
      properties:
        ok:
          type: boolean
        integrations:
          type: object
          description: One row per outside service. A row says live only after its own
            check passed; client means it runs only in the browser.
          required:
            - summary
            - rows
          properties:
            summary:
              type: object
              required:
                - live
                - fallback
                - off
                - client
                - of
              properties:
                live:
                  type: integer
                fallback:
                  type: integer
                off:
                  type: integer
                client:
                  type: integer
                of:
                  type: integer
            rows:
              type: array
              items:
                type: object
                required:
                  - id
                  - name
                  - mode
                  - detail
                  - checkedAt
                properties:
                  id:
                    type: string
                  name:
                    type: string
                  mode:
                    type: string
                    enum:
                      - live
                      - fallback
                      - off
                      - client
                  detail:
                    type: string
                  checkedAt:
                    type:
                      - string
                      - "null"
                    format: date-time
        build:
          type:
            - string
            - "null"
          description: The commit this answer came from.
        warnings:
          type: object
          description: CPSC's warnings file, apart from recalls. Not part of ok.
          properties:
            count:
              type: integer
            lastOkAt:
              type:
                - string
                - "null"
              format: date-time
            fresh:
              type: boolean
        degraded:
          type:
            - object
            - "null"
          description: Set when CPSC is the only thing failing.
          required:
            - source
            - since
            - lastGoodAt
          properties:
            source:
              type: string
              enum:
                - CPSC
            since:
              type:
                - string
                - "null"
              format: date-time
            lastGoodAt:
              type:
                - string
                - "null"
              format: date-time
        checkedAt:
          type: string
          format: date-time
        paypal:
          type: object
          description: PayPal's sandbox, and the Agent Toolkit that sends the demo shop's refunds.
          required:
            - environment
            - webhookConfigured
            - lastVerifiedWebhookAt
            - toolkit
          properties:
            environment:
              type: string
              enum:
                - sandbox
            webhookConfigured:
              type: boolean
            lastVerifiedWebhookAt:
              type:
                - string
                - "null"
              format: date-time
            toolkit:
              type: object
              description: Read from the installed package. The tools read as null until this
                server has loaded it, about 15 seconds after it starts.
              required:
                - version
                - loaded
                - tools
                - baseUrl
                - runs
              properties:
                version:
                  type:
                    - string
                    - "null"
                loaded:
                  type: boolean
                tools:
                  type:
                    - array
                    - "null"
                  items:
                    type: string
                baseUrl:
                  type:
                    - string
                    - "null"
                runs:
                  type: string
        market:
          type: object
          description: The search of the wider market. Not part of ok. Fresh means a
            search worked in the last 8 days.
          required:
            - lastOkAt
            - fresh
          properties:
            lastOkAt:
              type:
                - string
                - "null"
              format: date-time
            fresh:
              type: boolean
        checks:
          type: object
          required:
            - database
            - webhook
            - lastPull
            - purge
            - poll
            - replay
            - logging
          properties:
            database:
              type: boolean
            webhook:
              type: boolean
            lastPull:
              type: boolean
            purge:
              type: boolean
            poll:
              type: boolean
            replay:
              type: boolean
            logging:
              type: boolean
        database:
          type: object
          required:
            - ok
          properties:
            ok:
              type: boolean
    HealthDown:
      type: object
      required:
        - ok
        - database
      properties:
        ok:
          type: boolean
        database:
          type: object
          required:
            - ok
          properties:
            ok:
              type: boolean
info:
  title: Recall Reach public API
  version: 1.0.0
```