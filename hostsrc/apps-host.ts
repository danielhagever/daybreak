// A minimal MCP Apps host, so the Daybreak today can be seen outside Claude or ChatGPT.
// It connects to the Deskside MCP server, calls a tool, reads the tool's ui:// resource and
// renders it in a sandboxed iframe through the official AppBridge.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

const params = new URLSearchParams(location.search);
let ws = params.get("ws");
try {
  ws = ws || localStorage.getItem("daybreak-ws");
} catch {}
ws = ws || "demo";
const tool = params.get("tool") || "today_plan";
const log = (m: string) => {
  const el = document.getElementById("log")!;
  el.textContent += m + "\n";
};

async function main() {
  const client = new Client({ name: "daybreak-apps-preview", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`/mcp?ws=${encodeURIComponent(ws!)}`, location.origin)));
  log(`connected to /mcp as workspace ${ws}`);
  const { tools } = await client.listTools();
  const t = tools.find((x) => x.name === tool);
  const uri = (t?._meta as any)?.ui?.resourceUri;
  if (!uri) {
    log(`${tool} has no UI resource`);
    return;
  }
  const result = await client.callTool({ name: tool, arguments: {} });
  log(`called ${tool}`);
  const res = await client.readResource({ uri });
  const html = (res.contents[0] as any).text as string;
  log(`read ${uri} (${html.length} bytes)`);
  const iframe = document.getElementById("view") as HTMLIFrameElement;
  iframe.srcdoc = html;
  await new Promise((r) => (iframe.onload = r));
  const bridge = new AppBridge(
    client,
    { name: "Daybreak preview host", version: "0.1.0" },
    { serverTools: {}, openLinks: {}, logging: {} },
  );
  bridge.oninitialized = () => {
    log("view initialized, sending tool result");
    bridge.sendToolResult(result as any);
  };
  await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
}
main().catch((e) => log("error: " + (e as Error).message));
