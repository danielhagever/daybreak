export interface Env {
  DB: D1Database;
  AI: Ai;
  ASSETS: Fetcher;
}

export interface Profile {
  ws: string;
  parent_name: string;
  city: string;
  lat: number | null;
  lon: number | null;
  tz: string;
  checkin_by: string;
  family: { name: string; relation: string }[];
}

export interface Med {
  id: number;
  name: string;
  nickname: string;
  dose: string;
  times: string[];
  purpose: string;
  label_id: string | null;
}

export const nowIso = () => new Date().toISOString();

export function cleanWs(ws: string | null | undefined): string {
  const v = (ws ?? "demo")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 40);
  return v || "demo";
}

// Local calendar date and clock time in the parent's time zone.
export function localNow(tz: string, at: Date = new Date()): { day: string; time: string; weekday: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      weekday: "long",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${hour}:${parts.minute}`, weekday: parts.weekday };
}

export function spokenTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const ampm = h >= 12 ? "p.m." : "a.m.";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, "0")} ${ampm}` : `${h12} ${ampm}`;
}

export async function getProfile(env: Env, ws: string): Promise<Profile> {
  const r = await env.DB.prepare("SELECT * FROM profile WHERE ws = ?").bind(ws).first<any>();
  if (r) return { ...r, family: JSON.parse(r.family || "[]") };
  return { ws, parent_name: "Ruth", city: "", lat: null, lon: null, tz: "America/New_York", checkin_by: "10:30", family: [] };
}

export async function saveProfile(env: Env, p: Profile) {
  await env.DB.prepare(
    `INSERT INTO profile (ws, parent_name, city, lat, lon, tz, checkin_by, family, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ws) DO UPDATE SET parent_name = excluded.parent_name, city = excluded.city, lat = excluded.lat, lon = excluded.lon,
     tz = excluded.tz, checkin_by = excluded.checkin_by, family = excluded.family, updated_at = excluded.updated_at`,
  )
    .bind(p.ws, p.parent_name, p.city, p.lat, p.lon, p.tz, p.checkin_by, JSON.stringify(p.family), nowIso())
    .run();
}

export async function listMeds(env: Env, ws: string): Promise<Med[]> {
  const { results } = await env.DB.prepare("SELECT * FROM meds WHERE ws = ? AND active = 1 ORDER BY id").bind(ws).all<any>();
  return results.map((r) => ({ ...r, times: JSON.parse(r.times || "[]") }));
}

export async function dosesFor(env: Env, ws: string, day: string) {
  const { results } = await env.DB.prepare("SELECT * FROM doses WHERE ws = ? AND day = ?").bind(ws, day).all<any>();
  return results as { med_id: number; slot: string; status: string; at: string }[];
}

export async function addAlert(env: Env, ws: string, day: string, level: "info" | "warn" | "urgent", kind: string, text: string) {
  await env.DB.prepare("INSERT INTO alerts (ws, at, day, level, kind, text) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(ws, nowIso(), day, level, kind, text.slice(0, 400))
    .run();
}

export async function alertsFor(env: Env, ws: string, sinceDay: string) {
  const { results } = await env.DB.prepare("SELECT * FROM alerts WHERE ws = ? AND day >= ? ORDER BY id DESC LIMIT 40")
    .bind(ws, sinceDay)
    .all<any>();
  return results;
}

export function addDays(day: string, n: number): string {
  const d = new Date(day + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Resolve "my blood pressure pill", "the lisinopril", "my water pill" to a medication.
export function findMed(meds: Med[], said: string): Med | null {
  const q = said.toLowerCase();
  return (
    meds.find((m) => q.includes(m.name.toLowerCase())) ??
    meds.find((m) => m.nickname && q.includes(m.nickname.toLowerCase())) ??
    meds.find(
      (m) =>
        m.nickname &&
        m.nickname
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 3 && !["pill", "pills", "tablet", "medicine"].includes(w))
          .some((w) => q.includes(w)),
    ) ??
    meds.find(
      (m) =>
        m.purpose &&
        m.purpose
          .toLowerCase()
          .split(/\W+/)
          .filter((w) => w.length > 5)
          .some((w) => q.includes(w)),
    ) ??
    (meds.length === 1 && /\b(pill|pills|medicine|meds|medication|tablet)\b/.test(q) ? meds[0] : null)
  );
}
