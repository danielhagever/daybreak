# Friction log

Each entry: the task, what I expected, what happened, severity, the workaround, and a suggestion.
Severity: high = blocked progress, medium = cost real time, low = annoyance.

## 1. No outside-developer path into Alexa+
- **Task:** Run Daybreak inside Alexa+ on an Echo Show in a parent's kitchen.
- **Expected:** A sandbox where a self-hosted MCP server can be registered and tested by voice.
- **Actual:** No such path for hackathon entrants; the documented fallback is a simulated Alexa+ experience.
- **Severity:** high
- **Workaround:** A simulated Echo Show that is a real MCP client over Streamable HTTP, with Workers AI choosing tools and the Web Speech API for voice.
- **Suggestion:** An Alexa+ MCP sandbox (even text-only), and documentation of how Alexa+ handles a skill that needs to "hold the floor" for a short multi-question flow such as a check-in.

## 2. Multi-person households are not described
- **Task:** Let a daughter ask her own Echo "How is Mom doing?" about a different household.
- **Expected:** Guidance on how an Alexa+ MCP integration identifies the household and the speaker (account linking, voice profiles, OAuth scopes).
- **Actual:** No guidance for MCP integrations.
- **Severity:** medium
- **Workaround:** A household code in the MCP URL (`?ws=`), clearly a demo-grade identity.
- **Suggestion:** Document account linking and speaker identity for MCP-based Alexa+ experiences; caregiving is a large use case that needs it.

## 3. Proactive output has nowhere to go
- **Task:** When the cron finds "no check-in by 10:30", tell the family right away.
- **Expected:** A way for an MCP server to push a notification to a linked Alexa user (like proactive events for skills).
- **Actual:** MCP is request/response from the client's side; there is no documented Alexa+ channel for server-initiated notices.
- **Severity:** medium
- **Workaround:** Alerts are stored and surface in `family_update`, in the family web view, and in the next conversation.
- **Suggestion:** Expose a notification path for MCP integrations, with user consent, and rate limits suited to caregiving.

## 4. Function-calling models invent tool usage or pick the wrong tool
- **Task:** Reliable tool calls for safety-relevant requests.
- **Actual:** With `tool_choice: "required"`, a nonsense question ("what is the weather for?") was routed to a data-changing setup tool; in another case the model folded a question into the medicine-name argument.
- **Severity:** medium
- **Workaround:** Emergencies, check-in answers and label questions are routed by code before the model; setup is only exposed when it's the topic; tools return the sentences to speak.
- **Suggestion:** (for Alexa+) document which safety-critical intents Alexa+ handles itself, so integrations don't duplicate or conflict with them.

## 5. openFDA fuzzy search can return unrelated products
- **Task:** Find the label for a spoken medicine name.
- **Actual:** `openfda.brand_name:"weather"` returns a hand sanitizer named "Sweater Weather"; a generic search for lisinopril returned a combination product first.
- **Severity:** low
- **Workaround:** Exact-field searches first, then fuzzy ones accepted only if the brand or generic name contains the query, and answers say when the item isn't on the parent's list.
- **Suggestion:** (for openFDA) a ranked search that prefers single-ingredient products.
