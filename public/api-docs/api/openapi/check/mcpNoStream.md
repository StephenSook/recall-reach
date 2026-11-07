# Not offered. Every answer comes back on its own POST. (/api-docs/api/openapi/check/mcpNoStream)

`GET /api/mcp`

The server is stateless and opens no event stream, so a GET is refused with 405.

```yaml
openapi: 3.2.0
servers:
  - url: https://recall-reach-web-e022.onrender.com
    description: The deployed site. Its payments run on PayPal's sandbox.
paths:
  /api/mcp:
    get:
      tags:
        - Check
      operationId: mcpNoStream
      summary: Not offered. Every answer comes back on its own POST.
      description: The server is stateless and opens no event stream, so a GET is
        refused with 405.
      responses:
        "405":
          description: Use POST.
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
                await client.check.mcpNoStream();
              } catch (err) {
                // TODO: Handle 'err' of type Check.McpNoStreamError, discriminated with 'err.payload.kind'
              }
components:
  schemas:
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