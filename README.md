# Grok Bot ↔ Claude bridge

An MCP server that lets Claude drive the **Grok Bot desktop app** (v0.79.4) on this PC.

Grok Bot has no public API, so the bridge starts the app with Chromium's DevTools port
(`127.0.0.1:9333`, local only) and operates its chat window directly: it types into the
prompt box, presses Enter, and reads replies back from the transcript. Replies are "done"
when the app's own announcement changes from "*bot* is working" to "*bot* replied".

> Unofficial. Not made or supported by Grok Bot. Windows only for now; Node 22+.

## Install

```bash
git clone https://github.com/harkawataryan/grok-bridge.git
cd grok-bridge
npm install
```

Install and sign in to Grok Bot first. The bridge looks for it at
`%LOCALAPPDATA%\Programs\Grok Bot\Grok Bot.exe`. Set `GROK_BOT_EXE` if it's somewhere else,
and `GROK_CDP_PORT` to use a debug port other than 9333.

## Tools

| Tool | What it does |
|---|---|
| `grok_send` | Send a message (optionally to a named bot) and wait for the reply (default 120 s) |
| `grok_read` | Read the last N messages; can wait until the bot is idle |
| `grok_list_bots` | List bots, which one is open, and whether it's working |
| `grok_select_bot` | Switch to another bot |

| `grok_window` | Show the Grok Bot window (to watch or take over) or hide it again |

If Grok Bot isn't running, or was started normally without the debug port, the bridge
(re)starts it with the port. You stay signed in.

**Runs hidden.** When the bridge starts Grok Bot, the window starts hidden: no pop-up and no
taskbar button. It's also launched with Chromium's background throttling off, so hidden replies
arrive at full speed. To see it, ask Claude to show it (`grok_window`) or just open Grok Bot
from the Start menu. Set `GROK_HIDDEN=0` to launch it visibly instead. If you already have
Grok Bot open (with the debug port), the bridge leaves your window alone.

## Claude Desktop / Claude Code (local, stdio)

```json
"mcpServers": {
  "grok-bot": { "command": "node", "args": ["<this folder>/server.mjs"] }
}
```

Claude Code (also what the Claude Desktop **Code** tab uses):
`claude mcp add --scope user grok-bot -- node "<this folder>/server.mjs"`

The Chat tab reads `claude_desktop_config.json`; the Code tab reads Claude Code's own config
(`~/.claude.json`), so register it in both if you use both. Either way, fully quit and reopen
Claude Desktop (or start a new session) afterwards, because running sessions don't pick up new servers.

## Claude on web / phone

Two options:

1. **Through your desktop (recommended, nothing exposed):** keep Claude Desktop running on
   this PC with the bridge installed, and talk to it from your phone via Remote Control /
   Dispatch. The phone sends instructions to the desktop session, and the desktop session calls the bridge.
2. **As a custom connector (works in claude.ai chats and the mobile app):** run the bridge in
   HTTP mode behind a tunnel, then add `https://<your-host>/mcp/<token>` in claude.ai →
   Settings → Connectors → Add custom connector. The token is in `.bridge-token` and is the
   only thing protecting access. Anyone with the URL can make your bot place calls and
   send email, so keep it private. To rotate it, delete `.bridge-token` and restart the bridge.

   **Cloudflare Tunnel on your own domain (free):**
   ```bash
   cloudflared tunnel login                      # approve your domain in the browser
   cloudflared tunnel create grok-bridge
   cloudflared tunnel route dns grok-bridge grok.example.com
   ```
   `~/.cloudflared/config.yml`:
   ```yaml
   tunnel: <tunnel-id>
   credentials-file: C:\Users\<you>\.cloudflared\<tunnel-id>.json
   ingress:
     - hostname: grok.example.com
       service: http://127.0.0.1:8790
     - service: http_status:404
   ```
   `remote.ps1` keeps the bridge (HTTP mode) and the tunnel running and restarts either one if it
   stops; `remote-start.vbs` starts it with no window. Put a shortcut to `remote-start.vbs` in
   your Startup folder (`shell:startup`) to run it at login. Logs go to `logs/`.
   The PC has to be on and awake for the connector to work. (ngrok works too, e.g.
   `ngrok http 8790 --url <your-static-domain>`.)

## Notes / limits

- It drives the UI, so a Grok Bot update that renames its CSS classes
  (`sand-prompt-field`, `sand-transcript-row`, …) can break it. The selectors are in `grok.mjs`.
- While the debug port is open, any program on this PC can control the Grok Bot window.
  It is never reachable from the network.
- There's no "stop the bot" tool: the app has no stop control I could verify.
- `node test-client.mjs` runs a quick self-test, which sends one test message to the open bot.
