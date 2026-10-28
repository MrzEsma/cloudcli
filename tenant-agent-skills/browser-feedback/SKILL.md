---
name: browser-feedback
description: Drive the tenant's shared headless browser (Browser UI Feedback plugin) to open web pages, take screenshots, click, scroll, type, and inspect DOM elements non-interactively, or hand the session to the human so they can mark a UI region in the Browser UI Feedback tab. Use when a web page or frontend must be SEEN or verified visually (for example after applying frontend changes), when a user points at "this part" of a UI, or when a click-through flow must be exercised.
---

# Browser feedback

This tenant runs the `cloudcli-browser-feedback` CloudCLI plugin. Its headless
Chromium, the **Browser UI Feedback** tab the user can open, and your HTTP calls
all share the same server and the same in-memory sessions. The browser runs on
the CloudCLI host — the same container as workspace dev servers — so
`http://localhost:<port>` reaches a frontend you just started. Only `http` and
`https` URLs are accepted.

## Discover the server

```bash
BASE="http://127.0.0.1:$(node -p 'JSON.parse(require("fs").readFileSync(process.env.HOME+"/.claude-code-ui/browser-feedback-server.json","utf8")).port')"
curl -fsS "$BASE/status"   # data.available must be true (Chromium is preinstalled)
```

If the port file is missing or stale, the plugin server is not running — say so
and continue without the browser rather than retrying.

## Non-interactive use

```bash
# create a session and capture its id
SID=$(curl -fsS -X POST "$BASE/sessions" \
  | node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>console.log(JSON.parse(r).data.id))')

# open a page and save its screenshot for viewing
curl -fsS -X POST "$BASE/sessions/$SID/navigate" -H 'content-type: application/json' \
  -d '{"url":"http://localhost:5173"}' \
  | node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>{const u=JSON.parse(r).data.screenshotDataUrl;require("fs").writeFileSync("/tmp/browser-feedback.jpg",Buffer.from(u.split(",")[1],"base64"))})'
# then view /tmp/browser-feedback.jpg as an image
```

Actions (viewport is 1440x900; every response includes a fresh screenshot):

```bash
curl -fsS -X POST "$BASE/sessions/$SID/click"   -H 'content-type: application/json' -d '{"x":720,"y":80}'
curl -fsS -X POST "$BASE/sessions/$SID/scroll"  -H 'content-type: application/json' -d '{"deltaY":600}'
curl -fsS -X POST "$BASE/sessions/$SID/type"    -H 'content-type: application/json' -d '{"text":"hello"}'
curl -fsS -X POST "$BASE/sessions/$SID/inspect" -H 'content-type: application/json' -d '{"x":300,"y":200}'
# inspect returns data.element: tagName, id, className, role, ariaLabel, text, rect
```

Stop the session when finished (`curl -fsS -X POST "$BASE/sessions/$SID/stop"`).
At most 3 sessions may be active per tenant and idle sessions expire after 30
minutes — reuse one session instead of creating many.

## Interactive handoff (user marks a region)

When the user needs to point at a part of the UI — for example "fix this piece
of the frontend, it should behave like …" — keep your session open on the page
and ask them, in their language, to: open the **Browser UI Feedback** tab,
select this session, and use **Select region** on the area they mean. Their
selection calls `inspect` on your shared session:

```bash
# wait until the human marks a region (their action appears as lastAction)
while true; do
  A=$(curl -fsS "$BASE/sessions" \
    | node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>{const s=JSON.parse(r).data.sessions.find(x=>x.id===process.argv[1]);console.log(s?s.lastAction||"":"missing")})' "$SID")
  case "$A" in inspect:*) echo "$A"; break ;; esac
  sleep 5
done
# A is now "inspect:<x>,<y>" — replay inspect yourself to get the DOM element,
# and use the screenshot from that same response.
```

The note the user writes in the tab reaches the chat only when they choose
**Copy feedback** and paste it — remind them to paste it if you need their
wording.
