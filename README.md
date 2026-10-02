# Daybreak for Alexa+

**A good-morning check-in for parents who live alone, with the family in the loop.**

Millions of older adults live alone, and their adult children solve it with a daily phone call that both sides dread missing. Daybreak turns that call into a two-minute conversation with Alexa+: how did you sleep, how are you feeling, anything hurting, here are your medicines and appointments, and it's going to be 103 degrees so stay in this afternoon. The family sees the result without calling, and a quiet background check raises a flag when the good morning doesn't come.

- **Demo video (2.5 min):** https://youtu.be/1ohFs-dISFw
- **Live demo (simulated Echo Show, voice in and out):** https://daybreak.meshulam791.workers.dev (press "Load the sample household")
- **Family view:** https://daybreak.meshulam791.workers.dev/family.html
- **MCP endpoint (Streamable HTTP):** `https://daybreak.meshulam791.workers.dev/mcp?ws=<household>`
- **The "today" view as an MCP App, in a minimal host:** https://daybreak.meshulam791.workers.dev/apps.html

## What Alexa+ can do with it

| Who says | What | What happens |
|---|---|---|
| Parent | "Good morning" | `morning_checkin` asks three questions one at a time (sleep, mood one to five, pain), then reads the day: medicines by time, appointments, and heat or ice advice for their city. A low mood or pain is passed to the family. |
| Parent | "I took my blood pressure pill" | `log_dose` matches what they call it ("blood pressure pill") to the medicine on the list and records it. |
| Parent | "What is metformin for?" | `medication_info` reads the **official FDA label** (openFDA) and says it in plain words: "The FDA label lists metformin for blood sugar in type 2 diabetes." |
| Parent | "Can I take Advil with my blood pressure pill?" | The label search knows Advil is ibuprofen, an NSAID, so it finds what lisinopril's label actually says ("NSAIDs: increased risk of renal impairment…") and sends them to the pharmacist. It never gives advice of its own. |
| Parent | "I have a dentist appointment Friday at 2" | `add_appointment` turns the weekday into a date in the parent's time zone, reminds the evening before, and the family sees it. |
| Parent | "I fell in the kitchen" | Handled before any model runs: "If you are hurt or this is an emergency, call 911 now, or press your medical alert button." The family sees an urgent alert. |
| Daughter, on her own Echo | "How is Mom doing today?" | `family_update`: check-in time, mood, pain, medicines taken or missed, open alerts, and the week at a glance. |
| (nobody) | every 15 minutes | Per household, in the parent's own time zone: no check-in by the expected time, a dose not confirmed two hours after it was due, tomorrow's appointments in the evening, and heat or ice advisories in the morning all become family alerts. |

Also: `setup_household`, `add_medication` (looks up the label when added), `today_plan`, `report_concern`, `acknowledge_alerts` ("I've seen it", so siblings know someone is on it).

## How it fits the Alexa+ track

- **MCP server, spec 2025-11-25 and later, over Streamable HTTP**, built with `@modelcontextprotocol/server` 2.2.0 (`createMcpHandler`). The same endpoint also serves the 2026-07-28 revision.
- **State across sessions and across people.** The parent and their children talk to the same household. Check-ins, doses, appointments and alerts persist in Cloudflare D1.
- **Autonomous background work.** A cron trigger runs the household checks every 15 minutes in each parent's local time.
- **Agentic orchestration across services.** One "good morning" touches the check-in store, the medication schedule, the appointment list and live weather (Open-Meteo). "What is this for?" reads openFDA.
- **Media support, an MCP App.** `today_plan`, `family_update` and `log_dose` declare `ui://daybreak/today.html`: a large-print view of today's medicines with "I took it" buttons that call `log_dose` back through the host. It was tested end to end with the official `AppBridge` in `/apps.html`.
- **An Agent Skill**, [`skills/daybreak-checkin/SKILL.md`](skills/daybreak-checkin/SKILL.md), teaches any agent the check-in method and its safety rules.

## Safety and honesty rules built into the code

- **No medical advice.** Medicine answers quote the FDA label and always end with "check with your pharmacist or doctor." Only condition names are translated into plain words (hypertension becomes high blood pressure). The exact label sentence travels with the answer.
- **No false negatives about interactions.** Labels usually name drug classes, not brands, so asking about Advil or Aleve also searches for NSAIDs, and the answer says when the match is via the class.
- **Fuzzy label matches are checked.** A label result is used only if its brand or generic name contains what was asked. When something isn't on the parent's list, the answer says so and names the exact product the label belongs to.
- **Emergencies skip the model.** Phrases like "I fell" or "chest pain" go straight to the urgent path with the 911 guidance, so the reply never depends on a model's mood.
- **Data-changing tools are gated.** Household setup is only offered to the model when setup is clearly the topic, after a test in which a forced tool call landed on setup.
- **Facts come from the server.** Every tool returns the sentence to speak. When tools ran, the simulator speaks those sentences, so a model can't change "1 of 3 taken" into "all taken."

Heat advice follows the National Weather Service heat index classification ([weather.gov/ama/heatindex](https://www.weather.gov/ama/heatindex)): 90 to 103°F is "Extreme Caution," 103 to 124°F is "Danger."

## Run it yourself

```bash
npm install
npx wrangler d1 create daybreak             # put the id in wrangler.jsonc
npx wrangler d1 execute daybreak --remote --file=schema.sql
npx wrangler deploy
```

All data sources are free and keyless (openFDA, Open-Meteo), and everything runs on Cloudflare's free tier.

## Layout

```
src/index.ts        Worker: /mcp, /api/chat, /api/state, /api/seed, cron checks
src/server.ts       MCP server: tools, MCP App resource
src/external.ts     openFDA labels, plain-language terms, Open-Meteo weather advice
src/agent.ts        Simulated Alexa+: MCP client, Workers AI, safety routing
src/db.ts           D1 helpers, local time per household
src/ui/today.html   MCP App view
public/             Echo Show simulator, family view, MCP Apps preview host
skills/             Agent Skill
```

## License

MIT
