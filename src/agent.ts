// The simulated Alexa+ behind the demo page: an MCP client over Streamable HTTP, with a Workers AI
// model choosing Daybreak's tools and the browser's Web Speech API for voice.

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Env } from "./db";
import * as db from "./db";

// Chosen by measurement for the sibling Deskside project (2026-10-01): Llama 4 Scout called the
// right tools every time on the same script; Qwen3 30B claimed actions without calling tools.
export const MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

const SYSTEM = `You are Alexa+, running the Daybreak skill for an older adult who lives alone, and for their family.
Rules:
- Your reply is spoken aloud. One or two short, warm sentences. Plain words, no lists, no markdown.
- Always use the Daybreak tools instead of guessing.
- "Good morning" starts morning_checkin. Medicine taken: log_dose. "What's on today?": today_plan. A family member asking how their parent is: family_update.
- Never give medical advice. For questions about a medicine, call medication_info.
- When a tool result contains a "spoken" sentence, say that sentence. Never invent medicines, times, or appointments.`;

// Said by someone who may be hurt: handled before any model call, every time.
const EMERGENCY =
  /\b(i fell|i'?ve fallen|fell down|i can'?t get up|chest pain|can'?t breathe|cannot breathe|having a stroke|i'?m bleeding)\b/i;
const SMALL_TALK =
  /^(ok(ay)?[, ]*)?(thanks|thank you|thx|cool|great|perfect|bye|goodbye|good night|ok|okay|lovely)( so much| alexa| you| dear)?[\s!.]*$/i;
const NEW_REQUEST = /\b(what|when|add|remind|appointment|took|take|taken|medicine|pill|how is|how's|label|fell|help)\b/i;

type Msg = { role: "system" | "user" | "assistant" | "tool"; content: string; tool_calls?: any[]; tool_call_id?: string; name?: string };

export async function runTurn(
  env: Env,
  mcpFetch: (req: Request) => Promise<Response>,
  origin: string,
  ws: string,
  history: { role: "user" | "assistant"; content: string }[],
) {
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp?ws=${encodeURIComponent(ws)}`), {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => mcpFetch(new Request(input, init)),
  });
  const client = new Client({ name: "daybreak-alexa-sim", version: "0.1.0" });
  await client.connect(transport);
  const cards: Record<string, unknown>[] = [];
  const trace: { tool: string; args: unknown }[] = [];
  const utterance = (history[history.length - 1]?.content ?? "").trim();

  const direct = async (name: string, args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name, arguments: args });
    trace.push({ tool: name, args });
    if (r.structuredContent) cards.push({ tool: name, ...r.structuredContent });
    return r;
  };
  const done = async (r: any) => {
    await client.close();
    return { reply: String(r.structuredContent?.spoken ?? r.content?.[0]?.text ?? ""), cards, trace };
  };

  if (EMERGENCY.test(utterance)) return done(await direct("report_concern", { what: utterance, urgent: true }));
  if (SMALL_TALK.test(utterance)) {
    await client.close();
    return { reply: "You're welcome. I'm right here if you need me.", cards, trace };
  }
  if (/^(good )?morning\b/i.test(utterance)) return done(await direct("morning_checkin", {}));

  // While the morning check-in is waiting for an answer, the next thing said is that answer.
  const p = await db.getProfile(env, ws);
  const { day } = db.localNow(p.tz);
  const open = await env.DB.prepare("SELECT pending FROM checkins WHERE ws = ? AND day = ? AND pending IS NOT NULL")
    .bind(ws, day)
    .first<{ pending: string }>();
  if (open && !NEW_REQUEST.test(utterance)) {
    const r = await direct("morning_checkin", { answer: utterance });
    if (!r.isError) return done(r);
  }

  // Label questions have a few fixed shapes; parse them directly so the "about" part is never lost.
  const lq = labelQuestion(
    utterance,
    (await db.listMeds(env, ws)).flatMap((m) => [m.name, m.nickname].filter(Boolean)),
  );
  if (lq) return done(await direct("medication_info", lq));

  const { tools } = await client.listTools();
  // Household setup changes stored data, so the model only sees it when setup is clearly the topic.
  const setupTalk = /\b(set ?up|lives in|moved to|my (mom|mother|dad|father) is called|check-?in by)\b/i.test(utterance);
  const aiTools = tools
    .filter((t) => setupTalk || t.name !== "setup_household")
    .map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema } }));
  const now = db.localNow(p.tz);
  const messages: Msg[] = [
    { role: "system", content: `${SYSTEM}\nToday is ${now.weekday} ${now.day}, local time ${now.time}. The parent is ${p.parent_name}.` },
    ...history.slice(-10),
  ];
  const spoken: string[] = [];
  try {
    for (let round = 0; round < 4; round++) {
      const out: any = await env.AI.run(
        MODEL as any,
        { messages, tools: aiTools, max_tokens: 500, ...(round === 0 ? { tool_choice: "required" } : {}) } as any,
      );
      const msg = out?.choices?.[0]?.message ?? { content: out?.response ?? "", tool_calls: out?.tool_calls };
      const calls = (msg.tool_calls ?? []).map((c: any, i: number) => ({
        id: c.id ?? `call_${round}_${i}`,
        name: c.function?.name ?? c.name,
        args: parseArgs(c.function?.arguments ?? c.arguments),
      }));
      if (!calls.length) {
        await client.close();
        const text = String(msg.content ?? "").trim();
        return { reply: spoken.length ? [...new Set(spoken)].join(" ") : text || "Sorry, I didn't catch that.", cards, trace };
      }
      messages.push({
        role: "assistant",
        content: msg.content ?? "",
        tool_calls: calls.map((c: any) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })),
      });
      for (const c of calls) {
        let text: string;
        try {
          const r = await direct(c.name, c.args);
          if (r.isError) spoken.push(`Sorry, ${String(r.content?.[0]?.text ?? "that didn't work.")}`);
          else if (typeof r.structuredContent?.spoken === "string") spoken.push(r.structuredContent.spoken);
          text = JSON.stringify(r.structuredContent ?? r.content).slice(0, 3000);
        } catch (e) {
          text = `Tool error: ${(e as Error).message}`;
        }
        messages.push({ role: "tool", tool_call_id: c.id, name: c.name, content: text });
      }
    }
    await client.close();
    return { reply: spoken.join(" ") || "I'm still working on that.", cards, trace };
  } catch (err) {
    // Workers AI unavailable (for example the free daily quota): keep the core requests working.
    console.error("ai", (err as Error).message);
    const q = utterance.toLowerCase();
    const route = /\b(took|taken|had my)\b/.test(q)
      ? { name: "log_dose", args: { medication: utterance, status: "taken" } }
      : /\b(how is|how's|how are)\b/.test(q) && !/\bfeel/.test(q)
        ? { name: "family_update", args: {} }
        : /\b(today|plan|schedule|what do i have)\b/.test(q)
          ? { name: "today_plan", args: {} }
          : null;
    if (!route) {
      await client.close();
      return {
        reply: "I'm having trouble understanding right now. You can say good morning, I took my pill, or what's on today.",
        cards,
        trace,
        degraded: true,
      };
    }
    return done(await direct(route.name, route.args));
  }
}

function parseArgs(a: unknown): any {
  if (a && typeof a === "object") return a;
  try {
    return JSON.parse(String(a ?? "{}"));
  } catch {
    return {};
  }
}

export function labelQuestion(u: string, myMeds: string[]): { medication: string; about?: string } | null {
  const q = u
    .toLowerCase()
    .replace(/[?!.]+$/, "")
    .trim();
  const med = (text: string) =>
    myMeds.find((m) => text.includes(m)) ??
    text
      .replace(/^(my|the|a|an)\s+/, "")
      .replace(/\s+(pill|pills|tablets?|label)$/, "")
      .trim();
  let m = q.match(/^(?:does|do|did) (?:the |my )?(.+?) label (?:say|mention) (?:anything )?(?:about )?(.+)$/);
  if (m) return { medication: med(m[1]), about: m[2].replace(/^(any|anything about)\s+/, "") };
  m = q.match(/^can i (?:take|drink|have|eat|use) (.+?) (?:with|while (?:on|taking)) (?:my )?(.+)$/);
  if (m) return { medication: med(m[2]), about: m[1].replace(/^(an?|some)\s+/, "") };
  m = q.match(/^what(?: is|'s) (?:my )?(.+?) for$/);
  if (m && myMeds.some((x) => m![1].includes(x) || x.includes(m![1]))) return { medication: med(m[1]) };
  return null;
}
