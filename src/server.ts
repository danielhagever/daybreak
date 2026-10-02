// Daybreak MCP server: a daily check-in for a parent who lives alone, with the family in the loop.
// Spec 2025-11-25 and 2026-07-28 over Streamable HTTP (via createMcpHandler).

import { McpServer } from "@modelcontextprotocol/server";
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import * as db from "./db";
import type { Env } from "./db";
import { lookupLabel, mentions, geocode, weatherAdvice, plainPurpose, SYNONYMS } from "./external";
import todayHtml from "./ui/today.html";
import appBundle from "./ui/app-bundle.txt";

const TODAY_URI = "ui://daybreak/today.html";
type Result = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
const tidy = (s: string) =>
  s
    .replace(/\.\.(\s|$)/g, ".$1")
    .replace(/\s+/g, " ")
    .trim();
const reply = (spokenRaw: string, data: Record<string, unknown> = {}): Result => {
  const spoken = tidy(spokenRaw);
  return { content: [{ type: "text", text: spoken }], structuredContent: { spoken, ...data } };
};
const fail = (spoken: string): Result => ({ content: [{ type: "text", text: spoken }], isError: true });

const QUESTIONS: Record<string, string> = {
  sleep: "How did you sleep last night?",
  mood: "On a scale of one to five, how are you feeling this morning?",
  pain: "Is anything hurting or bothering you today?",
};

export function parseMood(s: string): number | null {
  const q = s.toLowerCase();
  const digit = q.match(/\b([1-5])\b/);
  if (digit) return Number(digit[1]);
  const words: [RegExp, number][] = [
    [/\bnot (too |that |so )?bad\b/, 3],
    [/\bnot (so |that |too )?(good|great|well)\b/, 2],
    [/\b(one|terrible|awful|horrible|very bad)\b/, 1],
    [/\b(two|bad|not (so )?good|not great|low|down|sad|tired|meh)\b/, 2],
    [/\b(three|okay|ok|alright|so-so|fine-ish|not bad)\b/, 3],
    [/\b(four|good|fine|well)\b/, 4],
    [/\b(five|great|excellent|wonderful|fantastic|very good)\b/, 5],
  ];
  // Check the low end first so "not good" wins over "good".
  for (const [re, n] of words) if (re.test(q)) return n;
  return null;
}

const NO_PAIN = /^(no|nope|nothing|none|no pain|i'?m fine|all good|not really|nothing at all)\b/i;
const SERIOUS = /(chest|can'?t breathe|short of breath|fell|fall|dizzy|faint|bleed|numb|slurred|confus)/i;

function resolveDay(spec: string, today: string, weekdayToday: string): string | null {
  const s = spec.trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (s === "today") return today;
  if (s === "tomorrow") return db.addDays(today, 1);
  const names = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const target = names.findIndex((n) => s.includes(n));
  if (target < 0) return null;
  const cur = names.indexOf(weekdayToday.toLowerCase());
  let delta = (target - cur + 7) % 7;
  if (delta === 0 && s.includes("next")) delta = 7;
  return db.addDays(today, delta);
}

async function todayData(env: Env, ws: string) {
  const p = await db.getProfile(env, ws);
  const { day, time } = db.localNow(p.tz);
  const meds = await db.listMeds(env, ws);
  const doses = await db.dosesFor(env, ws, day);
  const schedule = meds
    .flatMap((m) =>
      m.times.map((slot) => ({
        med_id: m.id,
        name: m.name,
        nickname: m.nickname,
        dose: m.dose,
        slot,
        status: doses.find((d) => d.med_id === m.id && d.slot === slot)?.status ?? (slot <= time ? "due" : "later"),
      })),
    )
    .sort((a, b) => a.slot.localeCompare(b.slot));
  const { results: appts } = await env.DB.prepare(
    "SELECT * FROM appointments WHERE ws = ? AND starts_at >= ? AND starts_at < ? ORDER BY starts_at",
  )
    .bind(ws, day, db.addDays(day, 8))
    .all<any>();
  const checkin = await env.DB.prepare("SELECT * FROM checkins WHERE ws = ? AND day = ?").bind(ws, day).first<any>();
  const alerts = await db.alertsFor(env, ws, day);
  return { p, day, time, meds, schedule, appts, checkin, alerts };
}

function apptSpoken(a: any, today: string): string {
  const [d, t] = String(a.starts_at).split("T");
  const when =
    d === today
      ? "today"
      : d === db.addDays(today, 1)
        ? "tomorrow"
        : new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  return `${a.title} ${when} at ${db.spokenTime(t)}${a.place ? `, at ${a.place}` : ""}`;
}

export function buildServer(env: Env, wsRaw: string): McpServer {
  const ws = db.cleanWs(wsRaw);
  const server = new McpServer(
    { name: "daybreak", version: "0.1.0", title: "Daybreak: a daily check-in for parents who live alone" },
    {
      instructions:
        "Daybreak helps an older adult who lives alone start the day, keep track of medicines and appointments, and keeps their family informed. " +
        "Speak warmly and simply, one or two sentences. When the parent says good morning, call morning_checkin and keep calling it with each answer until it says the check-in is done. " +
        "When a family member asks how their parent is doing, call family_update. Never give medical advice: medication_info only reads the official FDA label and always points to the pharmacist or doctor. " +
        "If someone mentions a fall, chest pain, trouble breathing or another emergency, call report_concern with urgent=true.",
    },
  );

  registerAppResource(
    server,
    "Daybreak today",
    TODAY_URI,
    { description: "Large-print view of today's check-in, medicines and appointments" },
    async () => ({
      contents: [{ uri: TODAY_URI, mimeType: RESOURCE_MIME_TYPE, text: todayHtml.replace("/*__APP_BUNDLE__*/", () => appBundle) }],
    }),
  );

  server.registerTool(
    "setup_household",
    {
      title: "Set up the household",
      description:
        "Saves the parent's name, their city (used for weather safety advice and their local time), the time by which the morning check-in is expected, and the family members who should be kept informed.",
      inputSchema: z.object({
        parent_name: z.string().describe("What the parent likes to be called, e.g. 'Ruth'"),
        city: z.string().describe("City and country or state, e.g. 'Phoenix, Arizona'"),
        checkin_by: z
          .string()
          .regex(/^\d{2}:\d{2}$/)
          .optional()
          .describe("Local time HH:MM, default 10:30"),
        family: z.array(z.object({ name: z.string(), relation: z.string() })).optional(),
      }),
    },
    async ({ parent_name, city, checkin_by, family }) => {
      const place = await geocode(city);
      if (!place) return fail(`I couldn't find ${city}. Try the nearest larger city.`);
      const old = await db.getProfile(env, ws);
      await db.saveProfile(env, {
        ws,
        parent_name,
        city: `${place.name}, ${place.country}`,
        lat: place.lat,
        lon: place.lon,
        tz: place.tz,
        checkin_by: checkin_by ?? old.checkin_by,
        family: family ?? old.family,
      });
      return reply(
        `All set for ${parent_name} in ${place.name}. I'll expect a good morning by ${db.spokenTime(checkin_by ?? old.checkin_by)}${(family ?? old.family).length ? ` and keep ${(family ?? old.family).map((f) => f.name).join(" and ")} in the loop` : ""}.`,
        { profile: { parent_name, city: place.name, tz: place.tz } },
      );
    },
  );

  server.registerTool(
    "morning_checkin",
    {
      title: "Morning check-in",
      description:
        "The daily good-morning conversation. Call it when the parent says good morning, then call it again with each answer (pass the parent's words as `answer`). It asks about sleep, mood from one to five, and pain, one question at a time, then reads the plan for the day. Family members see the result.",
      inputSchema: z.object({
        answer: z.string().optional().describe("The parent's answer to the last check-in question, in their words"),
      }),
    },
    async ({ answer }) => {
      const { p, day, time, schedule, appts } = await todayData(env, ws);
      let c = await env.DB.prepare("SELECT * FROM checkins WHERE ws = ? AND day = ?").bind(ws, day).first<any>();
      if (!c) {
        await env.DB.prepare("INSERT INTO checkins (ws, day, started_at, pending) VALUES (?, ?, ?, 'sleep')")
          .bind(ws, day, db.nowIso())
          .run();
        return reply(`Good morning, ${p.parent_name}! ${QUESTIONS.sleep}`, { checkin: { step: "sleep" } });
      }
      if (!c.pending)
        return reply(
          `You already checked in this morning at ${db.spokenTime(db.localNow(p.tz, new Date(c.completed_at)).time)}. ${schedule.some((s) => s.status === "due") ? "You still have medicine due." : ""}`.trim(),
          { checkin: c },
        );
      if (!answer) return reply(QUESTIONS[c.pending], { checkin: { step: c.pending } });

      let next: string | null = null;
      const extra: string[] = [];
      if (c.pending === "sleep") {
        await env.DB.prepare("UPDATE checkins SET sleep = ?, pending = 'mood' WHERE ws = ? AND day = ?")
          .bind(answer.slice(0, 200), ws, day)
          .run();
        next = "mood";
      } else if (c.pending === "mood") {
        const mood = parseMood(answer);
        if (mood === null)
          return reply(`Sorry, just a number from one to five: one is awful, five is wonderful. How are you feeling?`, {
            checkin: { step: "mood" },
          });
        await env.DB.prepare("UPDATE checkins SET mood = ?, pending = 'pain' WHERE ws = ? AND day = ?").bind(mood, ws, day).run();
        if (mood <= 2) {
          await db.addAlert(env, ws, day, "info", "low_mood", `${p.parent_name} rated their mood ${mood} out of 5 this morning.`);
          extra.push("I'm sorry it's a hard morning.");
        }
        next = "pain";
      } else if (c.pending === "pain") {
        const pain = NO_PAIN.test(answer.trim()) ? "none" : answer.slice(0, 200);
        await env.DB.prepare("UPDATE checkins SET pain = ?, pending = NULL, completed_at = ? WHERE ws = ? AND day = ?")
          .bind(pain, db.nowIso(), ws, day)
          .run();
        if (pain !== "none") {
          const serious = SERIOUS.test(pain);
          await db.addAlert(env, ws, day, serious ? "warn" : "info", "pain", `${p.parent_name} mentioned: "${pain}".`);
          extra.push(
            serious ? "I've let your family know, and if it gets worse or you feel unsafe, call 911." : "I'll mention that to your family.",
          );
        }
        // Check-in complete: read the plan for the day.
        const due = schedule.filter((s) => s.status === "due" || s.status === "later");
        const meds = due.length
          ? `Your medicines today: ${due.map((s) => `${s.nickname || s.name} at ${db.spokenTime(s.slot)}`).join(", ")}.`
          : "";
        const weather = p.lat != null ? (await weatherAdvice(p.lat, p.lon!)).spoken : "";
        const ap = appts.filter((a: any) => a.starts_at.slice(0, 10) <= db.addDays(day, 1)).map((a: any) => apptSpoken(a, day));
        const plan = [
          extra.join(" "),
          "Thank you, you're all checked in.",
          meds,
          ap.length ? `Coming up: ${ap.join("; ")}.` : "",
          weather,
          p.family.length ? `I'll let ${p.family[0].name} know you're up.` : "",
        ]
          .filter(Boolean)
          .join(" ");
        return reply(plan, { checkin: { step: "done" }, schedule, appointments: appts });
      }
      return reply([extra.join(" "), QUESTIONS[next!]].filter(Boolean).join(" "), { checkin: { step: next } });
    },
  );

  server.registerTool(
    "add_medication",
    {
      title: "Add a medicine to the schedule",
      description:
        "Adds a medicine with the times it's taken. Daybreak looks up the official FDA label to say what it's for. Use the medicine's name as written on the bottle.",
      inputSchema: z.object({
        name: z.string().describe("Name on the bottle, e.g. 'lisinopril' or 'Tylenol'"),
        nickname: z.string().optional().describe("What the parent calls it, e.g. 'blood pressure pill'"),
        dose: z.string().optional().describe("e.g. '10 mg, one tablet'"),
        times: z
          .array(z.string().regex(/^\d{2}:\d{2}$/))
          .min(1)
          .max(6)
          .describe("Local times HH:MM, e.g. ['08:00','20:00']"),
      }),
    },
    async ({ name, nickname, dose, times }) => {
      let label = null;
      try {
        label = await lookupLabel(name);
      } catch {}
      await env.DB.prepare(
        "INSERT INTO meds (ws, name, nickname, dose, times, purpose, label_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(
          ws,
          name.toLowerCase().slice(0, 60),
          (nickname ?? "").toLowerCase().slice(0, 60),
          (dose ?? "").slice(0, 80),
          JSON.stringify([...new Set(times)].sort()),
          label?.purpose.slice(0, 300) ?? "",
          label?.setId ?? null,
          db.nowIso(),
        )
        .run();
      const when = [...new Set(times)].sort().map(db.spokenTime).join(" and ");
      const plain = label ? plainPurpose(label.purpose + " " + (label.sections.indications_and_usage ?? "")) : "";
      const what = plain
        ? ` The FDA label lists it for ${plain}.`
        : label?.purpose
          ? ` The FDA label says: ${label.purpose}`
          : " I couldn't find its FDA label, so ask the pharmacist what it's for if you're unsure.";
      return reply(`Added ${nickname || name} at ${when}.${what}`, { medications: await db.listMeds(env, ws) });
    },
  );

  registerAppTool(
    server,
    "log_dose",
    {
      title: "Record a medicine taken or skipped",
      description:
        "Records that the parent took (or skipped) a medicine, e.g. 'I took my blood pressure pill'. The family sees it, and Daybreak stops reminding.",
      inputSchema: z.object({
        medication: z.string().describe("The medicine as the parent said it, e.g. 'blood pressure pill' or 'lisinopril'"),
        status: z.enum(["taken", "skipped"]).default("taken"),
        slot: z
          .string()
          .regex(/^\d{2}:\d{2}$/)
          .optional()
          .describe("Scheduled time if known"),
      }),
      _meta: { ui: { resourceUri: TODAY_URI, visibility: ["model", "app"] } },
    },
    async ({ medication, status, slot }) => {
      const { p, day, time } = await todayData(env, ws);
      const meds = await db.listMeds(env, ws);
      const m = db.findMed(meds, medication);
      if (!m)
        return fail(
          meds.length
            ? `I don't have ${medication} on the list. The list has ${meds.map((x) => x.nickname || x.name).join(", ")}.`
            : "There are no medicines on the list yet.",
        );
      const doses = await db.dosesFor(env, ws, day);
      const open = m.times.filter((t) => !doses.some((d) => d.med_id === m.id && d.slot === t));
      const pick = slot ?? open.filter((t) => t <= addMinutes(time, 90)).pop() ?? open[0] ?? m.times[m.times.length - 1];
      await env.DB.prepare(
        "INSERT INTO doses (ws, med_id, day, slot, status, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(ws, med_id, day, slot) DO UPDATE SET status = excluded.status, at = excluded.at",
      )
        .bind(ws, m.id, day, pick, status, db.nowIso())
        .run();
      const data = await todayData(env, ws);
      const left = data.schedule.filter((s) => s.status === "due");
      return reply(
        status === "taken"
          ? `Got it, ${m.nickname || m.name} for ${db.spokenTime(pick)} is taken.${left.length ? ` Still due: ${left.map((s) => s.nickname || s.name).join(", ")}.` : ""}`
          : `Okay, I noted that you skipped ${m.nickname || m.name}. If you're not sure about skipping, check with your doctor.`,
        { schedule: data.schedule, parent: p.parent_name },
      );
    },
  );

  server.registerTool(
    "medication_info",
    {
      title: "What does the label say about a medicine",
      description:
        "Reads the official FDA label for one of the parent's medicines: what it's for, notes for older adults, and whether the label mentions something specific (another medicine, alcohol, grapefruit). This is not medical advice; it always points to the pharmacist or doctor.",
      inputSchema: z.object({
        medication: z.string().describe("Just the medicine name, e.g. 'lisinopril'"),
        about: z
          .string()
          .optional()
          .describe("ONLY the thing to look for in the label, one or two words, e.g. 'ibuprofen', 'alcohol', 'grapefruit'"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ medication, about: aboutArg }) => {
      // Models sometimes fold the question into the medicine field: "lisinopril ... about ibuprofen?"
      const folded = medication.match(/\b(?:about|with|and)\s+([a-z][a-z-]{2,})\??\s*$/i);
      const about = aboutArg ?? folded?.[1];
      const meds = await db.listMeds(env, ws);
      const m = db.findMed(meds, medication);
      const name = m?.name ?? medication;
      const label = await lookupLabel(name).catch(() => null);
      if (!label) return fail(`I couldn't find an FDA label for ${name}. The pharmacist can tell you about it.`);
      const parts: string[] = [];
      if (!m)
        parts.push(
          `${medication} isn't on ${(await db.getProfile(env, ws)).parent_name}'s medicine list. The closest FDA label I found is for ${label.brand} (${label.generic.toLowerCase()}).`,
        );
      if (about) {
        const terms = SYNONYMS[about.toLowerCase()] ?? [about.toLowerCase()];
        const keys = [
          "drug_interactions",
          "warnings",
          "do_not_use",
          "ask_doctor",
          "ask_doctor_or_pharmacist",
          "warnings_and_cautions",
          "information_for_patients",
        ];
        let hit: { term: string; text: string } | null = null;
        for (const term of terms) {
          for (const k of keys) {
            const m = label.sections[k] ? mentions(label.sections[k], term, 1) : [];
            if (m.length) {
              hit = { term, text: m[0] };
              break;
            }
          }
          if (hit) break;
        }
        if (!hit) parts.push(`I didn't find ${about} in the ${name} label's warnings or interactions.`);
        else if (hit.term === about.toLowerCase()) parts.push(`The ${name} label mentions ${about}: "${hit.text}"`);
        else
          parts.push(
            `The ${name} label doesn't name ${about}, but it mentions ${hit.term.toUpperCase() === "NSAID" ? "NSAIDs, the group of pain relievers " + about + " belongs to" : hit.term}: "${hit.text}"`,
          );
      } else {
        const plain = plainPurpose(label.purpose + " " + (label.sections.indications_and_usage ?? ""));
        if (plain) parts.push(`The FDA label lists ${name} for ${plain}.`);
        else if (label.purpose) parts.push(`The label says ${name} is for: ${label.purpose}`);
        const ger = label.sections.geriatric_use
          ? label.sections.geriatric_use.replace(/^Geriatric Use\s*/i, "").split(/(?<=\.)\s/)[0]
          : "";
        if (ger) parts.push(`For older adults it says: ${ger}`);
      }
      parts.push("Please check with your pharmacist or doctor before changing anything.");
      return reply(parts.join(" "), { label: { brand: label.brand, generic: label.generic, source: label.url } });
    },
  );

  server.registerTool(
    "add_appointment",
    {
      title: "Add an appointment",
      description: "Saves an appointment so Daybreak reminds the parent the day before and the morning of, and the family can see it.",
      inputSchema: z.object({
        title: z.string().describe("e.g. 'Doctor Patel', 'Dentist', 'Hair salon'"),
        day: z.string().describe("'today', 'tomorrow', a weekday like 'Thursday', or YYYY-MM-DD"),
        time: z
          .string()
          .regex(/^\d{2}:\d{2}$/)
          .describe("Local time HH:MM, 24-hour"),
        place: z.string().optional(),
      }),
    },
    async ({ title, day: daySpec, time, place }) => {
      const p = await db.getProfile(env, ws);
      const now = db.localNow(p.tz);
      const d = resolveDay(daySpec, now.day, now.weekday);
      if (!d) return fail(`Which day is that? You can say today, tomorrow, or a day of the week.`);
      const startsAt = `${d}T${time}`;
      await env.DB.prepare("INSERT INTO appointments (ws, title, starts_at, place, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(ws, title.slice(0, 80), startsAt, (place ?? "").slice(0, 120), db.nowIso())
        .run();
      return reply(`Saved: ${apptSpoken({ title, starts_at: startsAt, place }, now.day)}. I'll remind you the day before.`, {
        appointment: { title, starts_at: startsAt, place },
      });
    },
  );

  registerAppTool(
    server,
    "today_plan",
    {
      title: "Today's plan",
      description:
        "What's on today for the parent: medicines and whether they're taken, appointments today and tomorrow, and weather safety advice. Use it for 'what do I have today?'",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: TODAY_URI } },
    },
    async () => {
      const { p, day, schedule, appts, checkin } = await todayData(env, ws);
      const due = schedule.filter((s) => s.status === "due");
      const later = schedule.filter((s) => s.status === "later");
      const weather = p.lat != null ? await weatherAdvice(p.lat, p.lon!) : null;
      const ap = appts.filter((a: any) => a.starts_at.slice(0, 10) <= db.addDays(day, 1)).map((a: any) => apptSpoken(a, day));
      const parts = [
        due.length
          ? `Due now: ${due.map((s) => s.nickname || s.name).join(", ")}.`
          : schedule.length
            ? "You're up to date on medicines."
            : "",
        later.length ? `Later: ${later.map((s) => `${s.nickname || s.name} at ${db.spokenTime(s.slot)}`).join(", ")}.` : "",
        ap.length ? `Appointments: ${ap.join("; ")}.` : "No appointments today or tomorrow.",
        weather?.spoken ?? "",
      ];
      return reply(parts.filter(Boolean).join(" "), { parent: p.parent_name, schedule, appointments: appts, weather, checkin });
    },
  );

  registerAppTool(
    server,
    "family_update",
    {
      title: "How is my parent doing",
      description:
        "For family members: today's check-in (time, sleep, mood, pain), medicines taken or missed, open alerts, upcoming appointments, and the last seven days at a glance.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: TODAY_URI } },
    },
    async () => {
      const { p, day, schedule, appts, checkin, alerts } = await todayData(env, ws);
      const since = db.addDays(day, -6);
      const week = await env.DB.prepare(
        "SELECT COUNT(*) AS n, AVG(mood) AS mood FROM checkins WHERE ws = ? AND day >= ? AND completed_at IS NOT NULL",
      )
        .bind(ws, since)
        .first<any>();
      const missed = await env.DB.prepare("SELECT COUNT(*) AS n FROM doses WHERE ws = ? AND day >= ? AND status = 'missed'")
        .bind(ws, since)
        .first<any>();
      const name = p.parent_name;
      const parts: string[] = [];
      if (checkin?.completed_at)
        parts.push(
          `${name} checked in at ${db.spokenTime(db.localNow(p.tz, new Date(checkin.completed_at)).time)}${checkin.mood ? `, feeling ${checkin.mood} out of 5` : ""}${checkin.pain && checkin.pain !== "none" ? `, and said "${checkin.pain}"` : ""}.`,
        );
      else if (checkin) parts.push(`${name} started the check-in but didn't finish it.`);
      else parts.push(`${name} hasn't checked in yet today. The check-in is expected by ${db.spokenTime(p.checkin_by)}.`);
      const taken = schedule.filter((s) => s.status === "taken").length;
      const missedToday = schedule.filter((s) => s.status === "missed").length;
      if (schedule.length)
        parts.push(`Medicines: ${taken} of ${schedule.length} taken so far${missedToday ? `, ${missedToday} missed` : ""}.`);
      const open = alerts.filter((a: any) => !a.ack && a.level !== "info");
      if (open.length) parts.push(`Needs attention: ${open[0].text}`);
      parts.push(
        `This week: ${week?.n ?? 0} of 7 check-ins${week?.mood ? `, average mood ${Number(week.mood).toFixed(1)}` : ""}, ${missed?.n ?? 0} missed doses.`,
      );
      return reply(parts.join(" "), {
        parent: name,
        schedule,
        appointments: appts,
        checkin,
        alerts,
        week: { checkins: week?.n ?? 0, mood: week?.mood ?? null, missed: missed?.n ?? 0 },
      });
    },
  );

  server.registerTool(
    "report_concern",
    {
      title: "Tell the family about a concern",
      description:
        "Records something the family should know: a fall, pain, feeling unwell, being lonely, a problem at home. Set urgent=true for a fall, chest pain, trouble breathing, or anything that sounds like an emergency.",
      inputSchema: z.object({ what: z.string().describe("In the parent's words"), urgent: z.boolean().default(false) }),
    },
    async ({ what, urgent }) => {
      const p = await db.getProfile(env, ws);
      const { day } = db.localNow(p.tz);
      const isUrgent = urgent || SERIOUS.test(what);
      await db.addAlert(env, ws, day, isUrgent ? "urgent" : "warn", "concern", `${p.parent_name}: "${what.slice(0, 200)}"`);
      const who = p.family.length ? p.family.map((f) => f.name).join(" and ") : "your family";
      return reply(
        isUrgent
          ? `If you are hurt or this is an emergency, call 911 now, or press your medical alert button if you have one. I've marked this urgent for ${who}.`
          : `Thank you for telling me. I've let ${who} know.`,
        { alert: { level: isUrgent ? "urgent" : "warn", what } },
      );
    },
  );

  server.registerTool(
    "acknowledge_alerts",
    {
      title: "Mark alerts as seen",
      description:
        "For family members: marks today's alerts as seen, with the name of who saw them, so other family members know someone is on it.",
      inputSchema: z.object({ by: z.string().describe("Family member's name") }),
    },
    async ({ by }) => {
      const p = await db.getProfile(env, ws);
      const { day } = db.localNow(p.tz);
      const r = await env.DB.prepare("UPDATE alerts SET ack = 1, ack_by = ? WHERE ws = ? AND day >= ? AND ack = 0")
        .bind(by.slice(0, 40), ws, db.addDays(day, -2))
        .run();
      return reply(
        r.meta.changes
          ? `Done. ${r.meta.changes} alert${r.meta.changes === 1 ? "" : "s"} marked as seen by ${by}.`
          : "There were no new alerts.",
      );
    },
  );

  return server;
}

function addMinutes(hhmm: string, mins: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const t = Math.min(23 * 60 + 59, h * 60 + m + mins);
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}
