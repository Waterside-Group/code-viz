#!/bin/sh
# Code Viz status line forwarder. `code-viz setup statusline add` copies this file to
# ~/.claude/code-viz/statusline.sh and points Claude Code's statusLine setting at it;
# `code-viz setup statusline remove` puts the previous setting back.
#
# Claude Code shares plan usage (percent of the 5-hour and weekly limits, and when they reset)
# only with status line commands. This passes the status line data to the local Code Viz
# server, which keeps only those numbers, then prints a short usage line. If you had a status
# line command before, it runs that instead and prints its output, so your status line stays
# the same.
CV_HOME="${CODE_VIZ_HOME:-$HOME/.claude/code-viz}"
PORT="${CODE_VIZ_PORT:-}"
case "$PORT" in
  '' | *[!0-9]*) PORT="$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$CV_HOME/config.json" 2>/dev/null | head -n 1)" ;;
esac
PORT="${PORT:-4455}"
INPUT="$(cat)"
LINE="$(printf '%s' "$INPUT" | curl -s -m 1 -X POST -H 'Content-Type: application/json' -H 'X-Code-Viz: 1' \
  --data-binary @- "http://127.0.0.1:$PORT/__cv/statusline" 2>/dev/null)"
if [ -s "$CV_HOME/statusline-previous.sh" ]; then
  printf '%s' "$INPUT" | sh "$CV_HOME/statusline-previous.sh"
elif [ -n "$LINE" ]; then
  printf '%s\n' "$LINE"
fi
exit 0
