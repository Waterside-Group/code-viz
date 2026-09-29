#!/bin/sh
# Make sure a Code Viz server at least as new as this plugin copy is running. Prints nothing on
# stdout: UserPromptSubmit hook output would be added to Claude's context.
DIR="$(dirname "$0")"
. "$DIR/common.sh"
PORT="$(cv_port)"
ROOT="$(cd "$DIR/.." && pwd)"
WANT="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/.claude-plugin/plugin.json" | head -n 1)"
HAVE="$(curl -s -m 1 "http://127.0.0.1:$PORT/__cv/health" 2>/dev/null | sed -n 's/.*"name":"code-viz","version":"\([^"]*\)".*/\1/p')"
# Sessions keep the plugin copy they started with, so an older session leaves a newer server
# alone instead of replacing it with its own version.
if [ -n "$HAVE" ] && awk -v a="$HAVE" -v b="$WANT" 'BEGIN { n = split(a, x, "."); m = split(b, y, "."); k = n > m ? n : m;
    for (i = 1; i <= k; i++) { if (x[i] + 0 > y[i] + 0) exit 0; if (x[i] + 0 < y[i] + 0) exit 1 } exit 0 }'; then
  exit 0
fi
NODE="$(cv_node)"
if [ -z "$NODE" ]; then
  echo "code-viz: node was not found; the viewer needs Node.js 18 or newer" >&2
  exit 0
fi
"$NODE" "$ROOT/server/cli.js" start </dev/null >/dev/null 2>&1
exit 0
