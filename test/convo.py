import json, sys, urllib.request
B = sys.argv[1] if len(sys.argv) > 1 else "https://daybreak.meshulam791.workers.dev"
ws = sys.argv[2] if len(sys.argv) > 2 else "convo1"
model = sys.argv[4] if len(sys.argv) > 4 else None
turns = sys.argv[3].split("|") if len(sys.argv) > 3 else []
hist = []
for u in turns:
    hist.append({"role": "user", "content": u})
    req = urllib.request.Request(B + "/api/chat", data=json.dumps({"ws": ws, "messages": hist, **({"model": model} if model else {})}).encode(), headers={"content-type": "application/json", "user-agent": "deskside-test/0.1"})
    d = json.load(urllib.request.urlopen(req, timeout=120))
    hist.append({"role": "assistant", "content": d["reply"]})
    print("YOU  :", u)
    print("ALEXA:", d["reply"])
    print("TOOLS:", [ (t["tool"], t["args"]) for t in d.get("trace", [])], d.get("error") or "")
    print()
