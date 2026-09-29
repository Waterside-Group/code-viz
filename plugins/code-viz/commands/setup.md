---
description: Set up Code Viz. Optionally adds a line to your CLAUDE.md that opens the viewer, and connects GitHub so line authors show GitHub names and avatars. Add "remove" to take the CLAUDE.md line out again.
argument-hint: "[remove]"
---
Run Code Viz setup for the user. Setup has two optional steps. Ask before each one, and change nothing the user has not said yes to. Never block on a step: if one is skipped or fails, go on to the next one.

In the steps below, CV means the Code Viz command line: `"${CLAUDE_PLUGIN_ROOT}/bin/code-viz"`.

Arguments: $ARGUMENTS

## If the arguments contain "remove"

The user asked to remove the CLAUDE.md block, so no question is needed. Run `CV setup claude-md remove`, report its output in one sentence (including any backup path it prints), and stop.

## Otherwise

1. Run `CV setup status`. It prints the path of the user's CLAUDE.md, whether it already has the Code Viz block, the exact block setup would add, and whether the GitHub CLI (`gh`) is installed and signed in.

2. **CLAUDE.md step.**
   - If the status says the block is present and up to date, say so in one line and go to step 3.
   - Otherwise show the user the exact block from the status output in a fenced code block, and the file it would be appended to. Explain in one or two sentences: in the Claude desktop app the block tells Claude to open the viewer at the start of every session. Code Viz's SessionStart hook already does this while auto-open is on, and it stops doing so while the block is in CLAUDE.md, so the two never double up. The block is for people who want the instruction in their own CLAUDE.md, where they can see and edit it; most people can skip this step.
   - Ask with the AskUserQuestion tool: "Add the Code Viz block to <path>?" (or, when a different version of the block is already there, "Update the Code Viz block in <path>?"), with the options "Yes, add it" and "No, skip". If AskUserQuestion is not available, ask the same question in plain text and wait for the answer.
   - Only on yes, run `CV setup claude-md add` and report the result, including the backup path it prints. On no, change nothing.

3. **GitHub step.** Code Viz shows who last changed each line of the file on screen. That already works without GitHub: names and emails come from `git blame`.
   - If the status says `gh` is signed in, say "GitHub: signed in as @<login>, so line authors show GitHub names and avatars" and go to step 4.
   - If the status says GitHub lookups are turned off in the config, say so in one line and go to step 4.
   - If `gh` is not installed, say in one sentence that installing the GitHub CLI (https://cli.github.com) and signing in adds GitHub names, avatars and pull request links to line authors, that it is optional, and go to step 4.
   - If `gh` is installed but not signed in, explain in one or two plain sentences: signing in lets Code Viz match commit authors to their GitHub profiles (name and avatar) and link each line to the pull request that merged it, for private repositories you can access too. Code Viz asks GitHub through your `gh` login and never stores a token. Then ask with AskUserQuestion: "Sign in to GitHub with the GitHub CLI now?" with the options "Yes, sign in" and "Skip".
     - On yes: run `gh auth login --hostname github.com --web` in the background, because it waits until the user finishes in the browser. Read its output for the one-time code and the URL (https://github.com/login/device), give both to the user, and open the URL for them (in the browser pane, or with `open` on macOS and `xdg-open` on Linux). When the command finishes, run `gh auth status --hostname github.com` to confirm. If this does not work here, tell the user to run `gh auth login` in their own terminal instead. Never ask for, print, or handle a token or password.
     - On skip: say they can sign in any time with `gh auth login`, and sign out with `gh auth logout`.

4. Run `CV setup done` so Code Viz does not offer setup again. Finish with a short summary: what changed (or that nothing did), the viewer URL (run `CV url`), and that `/code-viz:setup remove` takes the CLAUDE.md block out.
