import { toMcpTool } from "../operations/define";
import { fileOperations } from "../operations/files";

// Binary upload and streamed download can't cross JSON-RPC, so those two operations
// stay REST-only (POST /api/files, GET /api/files/:id) — a deliberate parity exception
// (AGENTS.md). Everything else (list, metadata, link-create, delete) is metadata-only
// and gets full MCP parity here (PROJ-234).
export const filesTools = fileOperations.map(toMcpTool);
