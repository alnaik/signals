// The worker's MCP server (stdio): exposes workerTools for one thread and nothing else.
// Usage: bun worker/mcp-server.ts <thread-id> [run-id]
import { serveTools } from "./mcp-serve.ts";
import { workerTools } from "./tools.ts";

const id = process.argv[2];
if (!id) throw new Error("thread id required");
await serveTools(workerTools(id, process.argv[3]));
