#!/bin/sh
# SessionStart: start the server and tell it about the session (payload on stdin). Then, as
# context for Claude:
#  - in the Claude desktop app, ask Claude to open the viewer in the browser pane, unless
#    auto-open is off or the user keeps that instruction in their own CLAUDE.md (added by
#    /code-viz:setup), so it is not given twice;
#  - the first time Code Viz runs, ask Claude to offer /code-viz:setup once.
DIR="$(dirname "$0")"
. "$DIR/common.sh"
PORT="$(cv_port)"
URL="http://localhost:$PORT"
CLAUDE_MD="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/CLAUDE.md"
"$DIR/ensure-server.sh" </dev/null >/dev/null 2>&1
"$DIR/hook.sh" >/dev/null 2>&1

CONTEXT=""
if [ "$CLAUDE_CODE_ENTRYPOINT" = "claude-desktop" ] && cv_auto_open \
    && ! grep -q 'code-viz:begin' "$CLAUDE_MD" 2>/dev/null; then
  CONTEXT="Code Viz (a plugin the user installed) shows the user an animated view of file edits at $URL. At the start of this session, as the first thing in your response to the user's first prompt (whatever it is), open that URL in the built-in browser pane with mcp__Claude_Browser__preview_start (url: $URL) so the user can watch, unless it is already open there. Do this once per session and there is no need to mention it in your reply."
fi
if [ ! -e "$CV_HOME/setup-offered" ] && mkdir -p "$CV_HOME" 2>/dev/null \
    && date -u '+%Y-%m-%dT%H:%M:%SZ' >"$CV_HOME/setup-offered" 2>/dev/null; then
  CONTEXT="$CONTEXT${CONTEXT:+ }Code Viz was just installed and this is its first session. Once, at the end of your reply to the user's first prompt, add one short sentence offering to run /code-viz:setup, which can add a line to their CLAUDE.md that opens the viewer, connect GitHub so line authors show GitHub names and avatars, and show plan usage in the viewer's usage strip. Only run it if the user says yes, and don't repeat the offer later."
fi
if [ -n "$CONTEXT" ]; then
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$CONTEXT"
fi
exit 0
