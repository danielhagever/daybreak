// Outside data Daybreak reads, all free and keyless, probed live on 2026-10-01:
// - openFDA drug labels (api.fda.gov) for what a medicine is for, in the label's own words.
// - Open-Meteo geocoding and forecast for heat and ice safety advice.
// Heat thresholds follow the US National Weather Service heat index classification
// (https://www.weather.gov/ama/heatindex): Extreme Caution 90-103 F, Danger 103-124 F.

const UA = { "user-agent": "Daybreak/0.1 (+https://github.com/danielhagever/daybreak)" };

export interface Label {
  setId: string;
  brand: string;
  generic: string;
  purpose: string; // short, from "purpose" (OTC) or the first sentence of "indications_and_usage" (Rx)
  sections: Record<string, string>;
  url: string;
}

const SECTIONS = [
  "purpose",
  "indications_and_usage",
  "warnings",
  "do_not_use",
  "ask_doctor",
  "ask_doctor_or_pharmacist",
  "stop_use",
  "geriatric_use",
  "drug_interactions",
  "information_for_patients",
  "boxed_warning",
  "warnings_and_cautions",
];

function clean(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/\(\s*\d+(\.\d+)*\s*\)/g, "")
    .replace(/^[0-9.]*\s*/, "")
    .trim();
}

function firstSentence(s: string): string {
  const body = clean(s).replace(/^(INDICATIONS (AND|&) USAGE|Indications and Usage|Purposes?|Uses)\s*/i, "");
  const m = body.match(/^(.{20,260}?[.;])(\s|$)/);
  return (m ? m[1] : body.slice(0, 220)).trim();
}

export async function lookupLabel(name: string): Promise<Label | null> {
  const q = name.trim().replace(/"/g, "");
  const tries = [
    `openfda.generic_name.exact:"${q.toUpperCase()}"`,
    `openfda.brand_name.exact:"${q.toUpperCase()}"`,
    `openfda.generic_name:"${q}"`,
    `openfda.brand_name:"${q}"`,
  ];
  for (const search of tries) {
    const url = `https://api.fda.gov/drug/label.json?search=${encodeURIComponent(search)}&limit=1`;
    const res = await fetch(url, { headers: UA, cf: { cacheTtl: 86400, cacheEverything: true } } as RequestInit);
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`openFDA answered ${res.status}`);
    const d: any = await res.json();
    const r = d.results?.[0];
    if (!r) continue;
    // Fuzzy searches can return an unrelated product ("weather" matched an antiseptic): keep a
    // result only if its brand or generic name actually contains what was asked for.
    const names = [...(r.openfda?.brand_name ?? []), ...(r.openfda?.generic_name ?? [])].join(" ").toLowerCase();
    if (!names.includes(q.toLowerCase())) continue;
    const sections: Record<string, string> = {};
    for (const k of SECTIONS) if (r[k]?.[0]) sections[k] = clean(String(r[k][0])).slice(0, 4000);
    const purpose = sections.purpose
      ? clean(sections.purpose.replace(/^Purposes?\s*/i, ""))
      : sections.indications_and_usage
        ? firstSentence(sections.indications_and_usage)
        : "";
    return {
      setId: r.set_id ?? r.id,
      brand: r.openfda?.brand_name?.[0] ?? q,
      generic: r.openfda?.generic_name?.[0] ?? q,
      purpose,
      sections,
      url: `https://api.fda.gov/drug/label.json?search=set_id:${r.set_id}`,
    };
  }
  return null;
}

// Sentences of a label section that mention a word, for "does my label say anything about X?"
export function mentions(text: string, word: string, max = 2): string[] {
  const w = word.toLowerCase();
  const out: string[] = [];
  for (const sentence of text.split(/(?<=[.;])\s+/)) {
    const i = sentence.toLowerCase().indexOf(w);
    if (i < 0) continue;
    if (sentence.length <= 220) {
      out.push(sentence.trim());
    } else {
      // Interaction tables run together without periods ("NSAIDS: ... Dual inhibition: ...").
      // Start at the term and stop at the next "Heading:" or after about 170 characters.
      const rest = sentence.slice(i);
      const next = rest.slice(w.length).search(/\s[A-Z][A-Za-z-]+(?: [a-z-]+){0,7}:\s/);
      const end = next > 0 ? Math.min(next + w.length, 170) : 170;
      let snip = rest.slice(0, end).trim();
      if (end === 170) snip = snip.replace(/\s+\S*$/, "") + "…";
      out.push(snip);
    }
    if (out.length >= max) break;
  }
  return out;
}

export interface Place {
  name: string;
  lat: number;
  lon: number;
  tz: string;
  country: string;
}

export async function geocode(city: string): Promise<Place | null> {
  // "Portland, Maine" must not become Portland, Oregon: prefer a candidate whose state or country
  // matches the text after the comma, otherwise the most populous match.
  const [name, ...rest] = city.split(",").map((x) => x.trim());
  const qualifier = rest.join(" ").toLowerCase();
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=10&language=en`;
  const d: any = await (await fetch(url, { headers: UA })).json();
  const list: any[] = d.results ?? [];
  if (!list.length) return null;
  const matches = qualifier
    ? list.filter((r) => [r.admin1, r.country, r.country_code].some((v) => v && (qualifier.includes(String(v).toLowerCase()) || String(v).toLowerCase().includes(qualifier))))
    : [];
  const r = [...(matches.length ? matches : list)].sort((a, b) => (b.population ?? 0) - (a.population ?? 0))[0];
  return { name: r.name, lat: r.latitude, lon: r.longitude, tz: r.timezone, country: r.country_code };
}

export interface WeatherAdvice {
  level: "none" | "caution" | "extreme_caution" | "danger" | "ice";
  maxFeelsF: number;
  minFeelsF: number;
  spoken: string;
}

export function adviceFrom(maxF: number, minF: number, precip: number): WeatherAdvice {
  if (maxF >= 103) return { level: "danger", maxFeelsF: maxF, minFeelsF: minF, spoken: `It will feel like ${maxF} degrees today. That's in the weather service's danger range, so please stay inside in the cool during the afternoon and keep a glass of water next to you.` };
  if (maxF >= 90) return { level: "extreme_caution", maxFeelsF: maxF, minFeelsF: minF, spoken: `It will feel like ${maxF} degrees today, hot enough for heat exhaustion. Drink water through the day and do errands in the morning.` };
  if (minF <= 32 && precip > 0) return { level: "ice", maxFeelsF: maxF, minFeelsF: minF, spoken: `It will be below freezing with some precipitation, so steps and sidewalks may be icy. Take it slow outside, or wait for it to warm up.` };
  if (maxF >= 80) return { level: "caution", maxFeelsF: maxF, minFeelsF: minF, spoken: `A warm day, feeling like ${maxF} at most. Keep some water handy.` };
  return { level: "none", maxFeelsF: maxF, minFeelsF: minF, spoken: `It will feel like ${maxF} degrees at most today.` };
}

const FORECAST = "daily=apparent_temperature_max,apparent_temperature_min,precipitation_sum&temperature_unit=fahrenheit&timezone=auto&forecast_days=1";

export async function weatherAdvice(lat: number, lon: number): Promise<WeatherAdvice> {
  const d: any = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&${FORECAST}`, { headers: UA, cf: { cacheTtl: 900, cacheEverything: true } } as RequestInit)).json();
  return adviceFrom(Math.round(d.daily.apparent_temperature_max[0]), Math.round(d.daily.apparent_temperature_min[0]), Number(d.daily.precipitation_sum[0] ?? 0));
}

// One request for many households (Open-Meteo accepts comma-separated coordinates), so the
// background check stays far below the free plan's 50 outbound calls per run.
export async function weatherAdviceMany(points: { lat: number; lon: number }[]): Promise<WeatherAdvice[]> {
  if (!points.length) return [];
  const lat = points.map((p) => p.lat).join(",");
  const lon = points.map((p) => p.lon).join(",");
  const d: any = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&${FORECAST}`, { headers: UA })).json();
  const list: any[] = Array.isArray(d) ? d : [d];
  return list.map((x) => adviceFrom(Math.round(x.daily.apparent_temperature_max[0]), Math.round(x.daily.apparent_temperature_min[0]), Number(x.daily.precipitation_sum[0] ?? 0)));
}

// Plain words for the conditions that appear most often in label indications. Only terms are
// translated; the exact label sentence is always available in the card and on request.
const PLAIN: [RegExp, string][] = [
  [/hypertension|high blood pressure/i, "high blood pressure"],
  [/glycemic control|type 2 diabetes|diabetes mellitus/i, "blood sugar in type 2 diabetes"],
  [/heart failure/i, "heart failure"],
  [/hyperlipidemia|hypercholesterolemia|ldl|cholesterol/i, "high cholesterol"],
  [/hypothyroidism/i, "an underactive thyroid"],
  [/gastroesophageal reflux|gerd|heartburn/i, "acid reflux and heartburn"],
  [/atrial fibrillation/i, "an irregular heartbeat (atrial fibrillation)"],
  [/angina/i, "chest pain from the heart (angina)"],
  [/myocardial infarction/i, "after a heart attack"],
  [/edema/i, "swelling (fluid build-up)"],
  [/osteoporosis/i, "bone thinning (osteoporosis)"],
  [/depress/i, "depression"],
  [/anxiety/i, "anxiety"],
  [/insomnia/i, "trouble sleeping"],
  [/pain reliever|analgesic|relief of (mild to moderate )?pain/i, "pain"],
  [/fever reducer|fever/i, "fever"],
  [/allerg/i, "allergies"],
  [/thrombo|blood clot|stroke/i, "preventing blood clots or stroke"],
  [/osteoarthritis|rheumatoid arthritis|arthritis/i, "arthritis"],
  [/benign prostatic hyperplasia|bph/i, "an enlarged prostate"],
];

export function plainPurpose(purpose: string): string {
  const hits: string[] = [];
  for (const [re, words] of PLAIN) if (re.test(purpose) && !hits.includes(words)) hits.push(words);
  return hits
    .slice(0, 3)
    .join(", ")
    .replace(/, ([^,]*)$/, " and $1");
}

// A question about "ibuprofen" should also find what the label says about NSAIDs, the group it
// belongs to, because labels usually name the class rather than every brand.
export const SYNONYMS: Record<string, string[]> = {
  ibuprofen: ["ibuprofen", "nsaid", "nonsteroidal", "non-steroidal", "anti-inflammatory"],
  advil: ["ibuprofen", "nsaid", "nonsteroidal", "non-steroidal", "anti-inflammatory"],
  motrin: ["ibuprofen", "nsaid", "nonsteroidal", "non-steroidal", "anti-inflammatory"],
  naproxen: ["naproxen", "nsaid", "nonsteroidal", "non-steroidal", "anti-inflammatory"],
  aleve: ["naproxen", "nsaid", "nonsteroidal", "non-steroidal", "anti-inflammatory"],
  aspirin: ["aspirin", "salicylate", "nsaid", "nonsteroidal", "non-steroidal"],
  tylenol: ["acetaminophen"],
  acetaminophen: ["acetaminophen"],
  alcohol: ["alcohol", "ethanol"],
  grapefruit: ["grapefruit"],
  potassium: ["potassium", "salt substitute"],
  salt: ["salt substitute", "potassium", "sodium"],
};
