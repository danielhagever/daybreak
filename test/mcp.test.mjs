// End-to-end tests against the live server through the official MCP client (Streamable HTTP),
// plus the simulator's /api/chat safety routes. Run: BASE=https://daybreak.meshulam791.workers.dev node --test test/
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const BASE = process.env.BASE ?? "https://daybreak.meshulam791.workers.dev";
const WS = "qa-" + Math.random().toString(36).slice(2, 8);
let client;
const call = (name, args = {}) => client.callTool({ name, arguments: args });
const spoken = (r) => r.structuredContent?.spoken ?? r.content?.[0]?.text ?? "";
const chat = async (ws, messages) => (await fetch(`${BASE}/api/chat`, { method: "POST", headers: { "content-type": "application/json", "user-agent": "daybreak-tests" }, body: JSON.stringify({ ws, messages }) })).json();

before(async () => {
  client = new Client({ name: "daybreak-tests", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp?ws=${WS}`)));
});
after(async () => client?.close());

test("lists the 10 tools and the MCP App resource", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["acknowledge_alerts", "add_appointment", "add_medication", "family_update", "log_dose", "medication_info", "morning_checkin", "report_concern", "setup_household", "today_plan"]);
  assert.deepEqual(tools.filter((t) => t._meta?.ui?.resourceUri === "ui://daybreak/today.html").map((t) => t.name).sort(), ["family_update", "log_dose", "today_plan"]);
  const res = await client.readResource({ uri: "ui://daybreak/today.html" });
  assert.equal(res.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.ok(!res.contents[0].text.includes("__APP_BUNDLE__"));
});

test("serves the 2025-11-25 protocol", async () => {
  const r = await fetch(`${BASE}/mcp?ws=${WS}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy", version: "1" } } }) });
  assert.match(await r.text(), /"protocolVersion":"2025-11-25"/);
});

test("setup uses the parent's own city and time zone", async () => {
  const r = await call("setup_household", { parent_name: "Miriam", city: "Tel Aviv", checkin_by: "09:30", family: [{ name: "Daniel", relation: "son" }] });
  assert.equal(r.structuredContent.profile.tz, "Asia/Jerusalem");
  assert.match(spoken(r), /Miriam/);
});

test("medicines: FDA purpose in plain words, unknown names handled", async () => {
  const a = await call("add_medication", { name: "lisinopril", nickname: "blood pressure pill", dose: "10 mg", times: ["08:00"] });
  assert.match(spoken(a), /high blood pressure/i);
  const b = await call("add_medication", { name: "metformin", nickname: "sugar pill", times: ["08:00", "18:00"] });
  assert.match(spoken(b), /blood sugar/i);
  const c = await call("add_medication", { name: "zzqxvitamin", times: ["12:00"] });
  assert.match(spoken(c), /couldn't find its FDA label/i);
});

test("label questions quote the label and point to the pharmacist", async () => {
  const r = await call("medication_info", { medication: "lisinopril", about: "ibuprofen" });
  assert.match(spoken(r), /NSAID/);
  assert.match(spoken(r), /pharmacist/);
  const purpose = await call("medication_info", { medication: "metformin" });
  assert.match(spoken(purpose), /blood sugar/i);
});

test("check-in: one question at a time, then the day; low mood alerts the family", async () => {
  const s1 = await call("morning_checkin", {});
  assert.match(spoken(s1), /sleep/i);
  const s2 = await call("morning_checkin", { answer: "badly, I kept waking up" });
  assert.match(spoken(s2), /one to five/i);
  const s3 = await call("morning_checkin", { answer: "not great" });
  assert.match(spoken(s3), /hurting/i);
  const s4 = await call("morning_checkin", { answer: "no, nothing" });
  assert.match(spoken(s4), /checked in/i);
  assert.match(spoken(s4), /blood pressure pill/);
  const again = await call("morning_checkin", {});
  assert.match(spoken(again), /already checked in/i);
  const fam = await call("family_update", {});
  assert.match(spoken(fam), /2 out of 5/);
});

test("doses: matched by nickname, unknown medicine refused", async () => {
  const r = await call("log_dose", { medication: "my blood pressure pill" });
  assert.match(spoken(r), /taken/);
  assert.equal(r.structuredContent.schedule.find((x) => x.name === "lisinopril").status, "taken");
  const bad = await call("log_dose", { medication: "aspirin" });
  assert.equal(bad.isError, true);
});

test("appointments resolve days in the parent's time zone", async () => {
  const r = await call("add_appointment", { title: "Dentist", day: "tomorrow", time: "14:00", place: "Dr. Levi" });
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());
  const d = new Date(today + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + 1);
  assert.equal(r.structuredContent.appointment.starts_at, `${d.toISOString().slice(0, 10)}T14:00`);
  const bad = await call("add_appointment", { title: "X", day: "someday", time: "10:00" });
  assert.equal(bad.isError, true);
});

test("today plan and family update carry the real schedule", async () => {
  const t = await call("today_plan", {});
  assert.ok(t.structuredContent.schedule.length >= 4);
  const f = await call("family_update", {});
  assert.match(spoken(f), /Medicines: 1 of/);
});

test("urgent concern gives 911 guidance and an urgent alert; acknowledge clears", async () => {
  const r = await call("report_concern", { what: "I fell in the bathroom", urgent: true });
  assert.match(spoken(r), /911/);
  const ack = await call("acknowledge_alerts", { by: "Daniel" });
  assert.match(spoken(ack), /marked as seen by Daniel/);
});

test("simulator: emergency phrase skips the model and alerts", async () => {
  const r = await chat(WS, [{ role: "user", content: "I've fallen and I can't get up" }]);
  assert.equal(r.trace[0].tool, "report_concern");
  assert.match(r.reply, /911/);
});

test("simulator: label question is routed with its topic", async () => {
  const r = await chat(WS, [{ role: "user", content: "Can I take Advil with my blood pressure pill?" }]);
  assert.equal(r.trace[0].tool, "medication_info");
  assert.equal(r.trace[0].args.about, "advil");
  assert.match(r.reply, /NSAID/);
});

test("simulator: small talk does not call tools", async () => {
  const r = await chat(WS, [{ role: "user", content: "thank you so much" }]);
  assert.equal(r.trace.length, 0);
});

test("sample household seeds cleanly", async () => {
  const ws = WS + "-seed";
  const r = await (await fetch(`${BASE}/api/seed?ws=${ws}`, { method: "POST", headers: { "user-agent": "daybreak-tests" } })).json();
  assert.equal(r.ok, true);
  const s = await (await fetch(`${BASE}/api/state?ws=${ws}`, { headers: { "user-agent": "daybreak-tests" } })).json();
  assert.equal(s.profile.parent_name, "Ruth");
  assert.equal(s.schedule.length, 3);
  assert.equal(s.appts.length, 1);
});
