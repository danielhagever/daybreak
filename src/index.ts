import { createMcpHandler } from "@modelcontextprotocol/server";
import * as db from "./db";
import type { Env } from "./db";
import { buildServer } from "./server";
import { runTurn } from "./agent";
import { lookupLabel, weatherAdvice } from "./external";

const wsOf = (req: Request) => db.cleanWs(new URL(req.url).searchParams.get("ws") ?? req.headers.get("x-daybreak-household"));
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function mcp(env: Env, req: Request): Promise<Response> {
  const ws = wsOf(req);
  return createMcpHandler(() => buildServer(env, ws), { onerror: (e) => console.error("mcp", e.message) }).fetch(req);
}

// A sample household so anyone can try Daybreak in one click.
async function seed(env: Env, ws: string) {
  await env.DB.batch(
    ["profile", "meds", "doses", "checkins", "appointments", "alerts"].map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE ws = ?`).bind(ws)),
  );
  await db.saveProfile(env, {
    ws,
    parent_name: "Ruth",
    city: "Phoenix, US",
    lat: 33.44838,
    lon: -112.07404,
    tz: "America/Phoenix",
    checkin_by: "10:30",
    family: [
      { name: "Maya", relation: "daughter" },
      { name: "David", relation: "son" },
    ],
  });
  const meds = [
    { name: "lisinopril", nickname: "blood pressure pill", dose: "10 mg, one tablet", times: ["08:00"] },
    { name: "metformin", nickname: "sugar pill", dose: "500 mg with food", times: ["08:00", "18:00"] },
  ];
  for (const m of meds) {
    const label = await lookupLabel(m.name).catch(() => null);
    await env.DB.prepare(
      "INSERT INTO meds (ws, name, nickname, dose, times, purpose, label_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(ws, m.name, m.nickname, m.dose, JSON.stringify(m.times), label?.purpose ?? "", label?.setId ?? null, db.nowIso())
      .run();
  }
  const { day } = db.localNow("America/Phoenix");
  await env.DB.prepare("INSERT INTO appointments (ws, title, starts_at, place, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(ws, "Doctor Patel, blood pressure check", `${db.addDays(day, 1)}T10:00`, "Banner clinic", db.nowIso())
    .run();
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) return mcp(env, req);

    if (url.pathname === "/api/chat" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as {
        ws?: string;
        messages?: { role: "user" | "assistant"; content: string }[];
      } | null;
      if (!body?.messages?.length) return json({ error: "messages required" }, 400);
      const history = body.messages
        .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .map((m) => ({ role: m.role, content: m.content.slice(0, 1000) }));
      const ws = db.cleanWs(body.ws);
      try {
        try {
          return json(await runTurn(env, (r) => mcp(env, r), url.origin, ws, history));
        } catch (e) {
          if (!/overloaded|D1_ERROR/i.test((e as Error).message)) throw e;
          await new Promise((r) => setTimeout(r, 1500));
          return json(await runTurn(env, (r) => mcp(env, r), url.origin, ws, history));
        }
      } catch (e) {
        console.error("chat", (e as Error).stack);
        return json({
          reply: "Sorry, something went wrong on my side. Please try again.",
          error: (e as Error).message,
          cards: [],
          trace: [],
        });
      }
    }

    if (url.pathname === "/api/seed" && req.method === "POST") {
      const ws = wsOf(req);
      if (ws === "demo") return json({ error: "use your own household code" }, 403);
      await seed(env, ws);
      return json({ ok: true, ws });
    }

    if (url.pathname === "/api/state") {
      const ws = wsOf(req);
      try {
        const p = await db.getProfile(env, ws);
        const { day, time } = db.localNow(p.tz);
        const meds = await db.listMeds(env, ws);
        const doses = await db.dosesFor(env, ws, day);
        const schedule = meds
          .flatMap((m) =>
            m.times.map((slot) => ({
              name: m.name,
              nickname: m.nickname,
              slot,
              status: doses.find((d) => d.med_id === m.id && d.slot === slot)?.status ?? (slot <= time ? "due" : "later"),
            })),
          )
          .sort((a, b) => a.slot.localeCompare(b.slot));
        const checkin = await env.DB.prepare("SELECT * FROM checkins WHERE ws = ? AND day = ?").bind(ws, day).first();
        const { results: week } = await env.DB.prepare(
          "SELECT day, mood, completed_at FROM checkins WHERE ws = ? AND day >= ? ORDER BY day",
        )
          .bind(ws, db.addDays(day, -6))
          .all();
        const { results: appts } = await env.DB.prepare(
          "SELECT * FROM appointments WHERE ws = ? AND starts_at >= ? ORDER BY starts_at LIMIT 10",
        )
          .bind(ws, day)
          .all();
        const alerts = await db.alertsFor(env, ws, db.addDays(day, -6));
        return json({ ws, profile: p, day, time, schedule, checkin, week, appts, alerts, meds });
      } catch (e) {
        return json({ error: (e as Error).message }, 503);
      }
    }

    return env.ASSETS.fetch(req);
  },

  // Every 15 minutes, per household, in the parent's own time zone: flag a missing morning
  // check-in, mark doses not taken within two hours as missed, remind about tomorrow's
  // appointments in the evening, and record heat or ice advisories in the morning.
  async scheduled(_e: ScheduledController, env: Env) {
    const { results: homes } = await env.DB.prepare("SELECT * FROM profile").all<any>();
    for (const row of homes) {
      const p = { ...row, family: JSON.parse(row.family || "[]") } as db.Profile;
      const { day, time } = db.localNow(p.tz);
      const { results: todays } = await env.DB.prepare("SELECT kind, text FROM alerts WHERE ws = ? AND day = ?").bind(p.ws, day).all<any>();
      const already = (kind: string, text?: string) => todays.some((a) => a.kind === kind && (!text || a.text === text));

      const checkin = await env.DB.prepare("SELECT completed_at FROM checkins WHERE ws = ? AND day = ?").bind(p.ws, day).first<any>();
      if (time > p.checkin_by && !checkin?.completed_at && !already("no_checkin")) {
        await db.addAlert(
          env,
          p.ws,
          day,
          "warn",
          "no_checkin",
          `No good-morning check-in from ${p.parent_name} yet (expected by ${db.spokenTime(p.checkin_by)}).`,
        );
      }

      const meds = await db.listMeds(env, p.ws);
      const doses = await db.dosesFor(env, p.ws, day);
      for (const m of meds) {
        for (const slot of m.times) {
          const [h, mm] = slot.split(":").map(Number);
          const late = `${String(Math.min(23, h + 2)).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
          if (time >= late && h + 2 <= 23 && !doses.some((d) => d.med_id === m.id && d.slot === slot)) {
            await env.DB.prepare("INSERT OR IGNORE INTO doses (ws, med_id, day, slot, status, at) VALUES (?, ?, ?, ?, 'missed', ?)")
              .bind(p.ws, m.id, day, slot, db.nowIso())
              .run();
            await db.addAlert(
              env,
              p.ws,
              day,
              "warn",
              "missed_dose",
              `${p.parent_name} hasn't confirmed the ${db.spokenTime(slot)} ${m.nickname || m.name}.`,
            );
          }
        }
      }

      if (time >= "18:00") {
        const { results: tomorrow } = await env.DB.prepare(
          "SELECT * FROM appointments WHERE ws = ? AND reminded = 0 AND starts_at >= ? AND starts_at < ?",
        )
          .bind(p.ws, db.addDays(day, 1), db.addDays(day, 2))
          .all<any>();
        for (const a of tomorrow) {
          await db.addAlert(
            env,
            p.ws,
            day,
            "info",
            "appointment",
            `Tomorrow at ${db.spokenTime(a.starts_at.slice(11, 16))}: ${a.title}${a.place ? ` (${a.place})` : ""}.`,
          );
          await env.DB.prepare("UPDATE appointments SET reminded = 1 WHERE id = ?").bind(a.id).run();
        }
      }

      if (time >= "06:00" && time < "12:00" && p.lat != null && !already("weather")) {
        const w = await weatherAdvice(p.lat, p.lon!).catch(() => null);
        if (w && w.level !== "none" && w.level !== "caution") await db.addAlert(env, p.ws, day, "info", "weather", w.spoken);
      }
    }
  },
};
