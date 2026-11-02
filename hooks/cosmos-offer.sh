#!/bin/bash
# Cosmos launch prompt: a Claude Code SessionStart hook (async, prints nothing, costs zero tokens).
# Asks "Open Cosmos?" when a session starts and Cosmos is not already open.
# Buttons: Open (starts Cosmos if needed), Not today (quiet until tomorrow), Skip (quiet for 15 minutes).
# The only files it writes are small timestamps in cosmos/cache/.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"   # the Cosmos folder this script lives in
PORT=4747
URL="http://127.0.0.1:$PORT"
STATE="$ROOT/cache"
SNOOZE_DAY="$STATE/launch-snooze-day"     # holds a YYYY-MM-DD: no prompts that day
SKIP_UNTIL="$STATE/launch-skip-until"     # holds an epoch time: no prompts before it

input="$(cat 2>/dev/null)"

# Subagents and --agent sessions: never ask.
case "$input" in *'"agent_type"'*) exit 0 ;; esac

# Cosmos settings (written by the Cosmos server on every settings save): launch prompt on/off and
# which entrypoints it covers. Missing file = the defaults below.
CONFIG="$STATE/launch-config"
entrypoints="cli claude-desktop claude-vscode"
if [ -f "$CONFIG" ]; then
  grep -qx 'enabled=0' "$CONFIG" 2>/dev/null && exit 0
  line="$(grep -m1 '^entrypoints=' "$CONFIG" 2>/dev/null)"
  [ -n "$line" ] && entrypoints="$(printf '%s' "${line#entrypoints=}" | tr -cd 'a-z0-9 -')"
fi

# Only sessions the owner opens (by default the terminal, the desktop app, the VS Code extension),
# and only those listed in the config. Never -p or SDK runs.
case "${CLAUDE_CODE_ENTRYPOINT:-}" in cli|claude-desktop|claude-vscode) ;; *) exit 0 ;; esac
case " $entrypoints " in *" ${CLAUDE_CODE_ENTRYPOINT} "*) ;; *) exit 0 ;; esac

# Respect "Not today" and "Skip".
today="$(date +%F)"; now="$(date +%s)"
[ -f "$SNOOZE_DAY" ] && [ "$(cat "$SNOOZE_DAY" 2>/dev/null)" = "$today" ] && exit 0
[ -f "$SKIP_UNTIL" ] && [ "$now" -lt "$(cat "$SKIP_UNTIL" 2>/dev/null || echo 0)" ] && exit 0

# Cosmos already open where the owner can see it: never ask. /api/viewers counts only pages that
# are visible (a hidden or background tab reports itself hidden), so a hidden tab still asks.
viewers="$(curl -sf -m 0.5 "$URL/api/viewers" 2>/dev/null | tr -cd '0-9')"
[ -n "$viewers" ] && [ "$viewers" -gt 0 ] && exit 0

# One dialog at a time, even if several sessions start together.
pgrep -f "Open Cosmos?" >/dev/null 2>&1 && exit 0

# The session that just started: Open flies straight to it (#session=<sid>). UUID characters only.
sid="$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9-]*\)".*/\1/p' | head -c 64)"
target="$URL/web/galaxy.html"
[ -n "$sid" ] && target="$target#session=$sid"

project="$(printf '%s' "$input" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | sed 's#/\.claude/worktrees/.*##; s#.*/##')"
# The name goes inside an AppleScript string: drop quotes, backslashes and control characters.
project="$(printf '%s' "$project" | tr -d '"\\' | tr -d '[:cntrl:]' | head -c 80)"
[ -z "$project" ] && project="a project"

(
  answer="$(osascript -e "display dialog \"New Claude session in $project. Open Cosmos?\" with title \"Cosmos\" buttons {\"Skip\", \"Not today\", \"Open\"} cancel button \"Skip\" giving up after 20" 2>/dev/null)"
  mkdir -p "$STATE"
  case "$answer" in
    *"button returned:Open"*)
      if ! curl -sf -m 0.5 "$URL/" >/dev/null 2>&1; then
        ( cd "$ROOT" && nohup node server.mjs >/dev/null 2>&1 & )
        for _ in 1 2 3 4 5 6 7 8 9 10; do curl -sf -m 0.3 "$URL/" >/dev/null 2>&1 && break; sleep 0.3; done
      fi
      open "$target"
      ;;
    *"button returned:Not today"*) echo "$today" > "$SNOOZE_DAY" ;;
    *) echo $(( $(date +%s) + 900 )) > "$SKIP_UNTIL" ;;  # Skip, Esc, or no answer in 20 s
  esac
) </dev/null >/dev/null 2>&1 &

exit 0
