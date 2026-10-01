// Turns the ext-apps browser bundle (an ES module ending in `export{a as B,...}`) into a
// script that exposes its exports on window.McpApps, so it can be inlined into an MCP App view.
import { readFileSync, writeFileSync } from "node:fs";
const src = readFileSync("node_modules/@modelcontextprotocol/ext-apps/dist/src/app-with-deps.js", "utf8");
const m = src.match(/export\s*\{([^}]*)\}\s*;?\s*(\/\/# sourceMappingURL=.*)?\s*$/);
if (!m) throw new Error("export block not found");
const pairs = m[1].split(",").map((p) => p.trim()).filter(Boolean).map((p) => {
  const [local, , exported] = p.split(/\s+/);
  return `${exported ?? local}:${local}`;
});
const out = src.slice(0, m.index) + `;window.McpApps={${pairs.join(",")}};`;
writeFileSync("src/ui/app-bundle.txt", out);
console.log("app-bundle.txt", out.length, "bytes,", pairs.length, "exports");
