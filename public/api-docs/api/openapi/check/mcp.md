# The same check as an MCP tool over Streamable HTTP (/api-docs/api/openapi/check/mcp)

`POST /api/mcp`

Two read-only tools: check_recall(title, model), and get_recall(recallNumber), which gives one recall's CPSC text. Stateless: each request stands alone. Send JSON-RPC 2.0, with Accept application/json, text/event-stream. It shares the limit of /api/check.

```yaml
openapi: 3.2.0
servers:
  - url: https://recall-reach-web-e022.onrender.com
    description: The deployed site. Its payments run on PayPal's sandbox.
paths:
  /api/mcp:
    post:
      tags:
        - Check
      operationId: mcp
      summary: The same check as an MCP tool over Streamable HTTP
      description: "Two read-only tools: check_recall(title, model), and
        get_recall(recallNumber), which gives one recall's CPSC text. Stateless:
        each request stands alone. Send JSON-RPC 2.0, with Accept
        application/json, text/event-stream. It shares the limit of /api/check."
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required:
                - jsonrpc
                - method
              properties:
                jsonrpc:
                  type: string
                  description: Always "2.0".
                  examples:
                    - "2.0"
                id:
                  type: integer
                  description: The request's number, sent back with its answer.
                method:
                  type: string
                  description: An MCP method, such as tools/list or tools/call.
                  examples:
                    - tools/list
                params:
                  type: object
                  description: The method's arguments, such as a tool's name and its arguments.
      responses:
        "200":
          description: A JSON-RPC response.
          content:
            application/json:
              schema:
                type: object
        "413":
          description: The request is too large.
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
                const response = await client.check.mcp({
                  body: {
                    jsonrpc: "some example string",
                    method: "some example string",
                  },
                });
                // TODO: Handle 'response' of type Record<string, unknown>
              } catch (err) {
                // TODO: Handle 'err' of type Check.McpError, discriminated with 'err.payload.kind'
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