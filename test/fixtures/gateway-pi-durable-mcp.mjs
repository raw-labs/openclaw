import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod/v4";

const server = new McpServer({ name: "pi-durable-mcp-proof", version: "1.0.0" });
const uri = "ui://pi-durable-proof/app";
const show = server.registerTool(
  "show",
  { inputSchema: z.object({}), annotations: { readOnlyHint: true } },
  async () => ({
    content: [{ type: "text", text: "Opened Pi Durable App." }],
  }),
);
show.update({
  _meta: { ui: { resourceUri: uri }, "openai/ui": { entrypoints: [{ type: "global" }] } },
});
const click = server.registerTool(
  "click",
  { inputSchema: z.object({}), annotations: { readOnlyHint: true } },
  async () => ({
    content: [{ type: "text", text: "Pi Durable App click settled." }],
  }),
);
click.update({ _meta: { ui: { visibility: ["app"] } } });
server.registerResource("app", uri, { mimeType: "text/html;profile=mcp-app" }, async () => ({
  contents: [{ uri, mimeType: "text/html;profile=mcp-app", text: "<main>Pi Durable App</main>" }],
}));
await server.connect(new StdioServerTransport());
