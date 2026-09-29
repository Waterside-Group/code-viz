#!/bin/sh
# Forward a Claude Code hook event (JSON on stdin) to the Code Viz server.
# Always exits 0 and prints nothing, so it can never block or fail a tool call, and never adds
# anything to Claude's context (UserPromptSubmit output would be).
DIR="$(dirname "$0")"
. "$DIR/common.sh"
PORT="$(cv_port)"
if ! curl -s -m 2 -o /dev/null -X POST \
    -H 'Content-Type: application/json' -H 'X-Code-Viz: 1' \
    -H "X-Code-Viz-Entry: ${CLAUDE_CODE_ENTRYPOINT:-}" \
    --data-binary @- "http://127.0.0.1:$PORT/__cv/hook" 2>/dev/null; then
  # Not running: start it in the background so the next event gets through.
  ( "$DIR/ensure-server.sh" </dev/null >/dev/null 2>&1 & )
fi
exit 0
