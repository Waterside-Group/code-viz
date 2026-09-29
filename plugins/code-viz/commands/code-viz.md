---
description: Open the Code Viz live viewer in the browser pane. Add "demo" to play a demo.
argument-hint: "[demo]"
---
Open the Code Viz viewer for the user.

1. Run `"${CLAUDE_PLUGIN_ROOT}/bin/code-viz" url`. It starts the server if needed and prints the viewer URL (http://localhost:4455 unless the user changed the port). If it prints an error instead, tell the user what it says and stop.
2. Open that URL in the built-in browser pane with mcp__Claude_Browser__preview_start. If that tool is not available (for example in a terminal session), run `"${CLAUDE_PLUGIN_ROOT}/bin/code-viz" open` instead, which opens it in the default browser.
3. If the arguments contain "demo", run `"${CLAUDE_PLUGIN_ROOT}/bin/code-viz" demo`.

Arguments: $ARGUMENTS

Reply with one short sentence.
