// A minimal MCP stdio server: tools/list and tools/call over JSON-RPC, arguments validated
// against each tool's schema before it runs. Used by the worker and the apply station.
import type { ToolDef } from "./tools.ts";
import { validate } from "./validate.ts";

export async function serveTools(tools: ToolDef[], onCall?: (name: string) => void): Promise<void> {
  const write = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);
  const reply = (id: unknown, result: unknown) => write({ jsonrpc: "2.0", id, result });
  const fail = (id: unknown, message: string) =>
    write({ jsonrpc: "2.0", id, error: { code: -32603, message } });

  async function handle(msg: { id?: unknown; method: string; params?: Record<string, unknown> }) {
    if (msg.id === undefined) return;
    if (msg.method === "initialize") {
      return reply(msg.id, {
        protocolVersion: (msg.params?.protocolVersion as string) ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "jobsignal", version: "0.1" },
      });
    }
    if (msg.method === "tools/list") {
      return reply(msg.id, {
        tools: tools.map(({ name, description, input_schema }) => ({
          name,
          description,
          inputSchema: input_schema,
        })),
      });
    }
    if (msg.method === "tools/call") {
      const name = String(msg.params?.name);
      const tool = tools.find((t) => t.name === name);
      if (!tool) return fail(msg.id, `Unknown tool ${name}`);
      onCall?.(name);
      const args = (msg.params?.arguments as Record<string, unknown>) ?? {};
      const invalid = validate(args, tool.input_schema);
      if (invalid) return reply(msg.id, { content: [{ type: "text", text: invalid }], isError: true });
      try {
        return reply(msg.id, { content: [{ type: "text", text: JSON.stringify(await tool.run(args)) }] });
      } catch (err) {
        return reply(msg.id, {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        });
      }
    }
    if (msg.method === "ping") return reply(msg.id, {});
    fail(msg.id, `Unsupported method ${msg.method}`);
  }

  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += dec.decode(chunk);
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      if (line) await handle(JSON.parse(line));
    }
  }
}
