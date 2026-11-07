import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type ApiMcpRequest = {
  /** Always "2.0". */
  jsonrpc: string;
  /** The request's number, sent back with its answer. */
  id?: number;
  /** An MCP method, such as tools/list or tools/call. */
  method: string;
  /** The method's arguments, such as a tool's name and its arguments. */
  params?: Record<string, unknown>;
};

export const apiMcpRequestSchema: Schema<ApiMcpRequest> = s.object<ApiMcpRequest>({
  jsonrpc: s.string(),
  id: s.optional(s.int()),
  method: s.string(),
  params: s.optional(s.record(s.string(), s.unknown())),
});
