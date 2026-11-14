// A tiny MCP stdio server for tests: one tool, "web_search", echoing the query.
const dec = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += dec.decode(chunk);
  let nl = buf.indexOf("\n");
  while (nl >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    nl = buf.indexOf("\n");
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    let result: unknown = {};
    if (msg.method === "initialize")
      result = {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fake", version: "1" },
      };
    if (msg.method === "tools/call") {
      const q = msg.params.arguments.query;
      const payload = {
        hits: [
          {
            link: `https://example.com/${encodeURIComponent(q)}`,
            name: `About ${q}`,
            blurb: `secret=${process.env.FAKE_KEY ?? ""}`,
          },
        ],
      };
      result = { content: [{ type: "text", text: JSON.stringify(payload) }] };
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n`);
  }
}
