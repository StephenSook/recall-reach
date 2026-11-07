# Whether the server answers. Touches no database. (/api-docs/api/openapi/status/live)

`GET /api/live`

For the host's health check. It says only that the server is up.

```yaml
openapi: 3.2.0
servers:
  - url: https://recall-reach-web-e022.onrender.com
    description: The deployed site. Its payments run on PayPal's sandbox.
paths:
  /api/live:
    get:
      tags:
        - Status
      operationId: live
      summary: Whether the server answers. Touches no database.
      description: For the host's health check. It says only that the server is up.
      responses:
        "200":
          description: It answers.
      x-apimatic-codeSamples:
        - lang: typescript
          label: TypeScript
          sources:
            Example: >-
              try {
                await client.status.live();
              } catch (err) {
                // TODO: Handle 'err' of type ApiError, where 'err.payload' is always the Undeclared arm
              }
info:
  title: Recall Reach public API
  version: 1.0.0
```