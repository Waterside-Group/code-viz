---
description: Check for a newer version of Code Viz (a new commit on its main branch) and install it if you want.
---
Check whether Code Viz has an update and offer to install it. Install nothing the user has not said yes to.

In the steps below, CV means the Code Viz command line: `"${CLAUDE_PLUGIN_ROOT}/bin/code-viz"`.

1. Run `CV update check --force`. It prints the installed commit, the latest commit on the main branch, whether an update is available, the commits in between, and a compare link.
2. If it says this copy is loaded from a local directory, explain in one sentence that Claude Code doesn't update that kind of install and that `git pull` in that directory updates it, then stop.
3. If it could not check (offline, for example) or says Code Viz is up to date, say so in one line and stop.
4. Otherwise show the installed and latest short commits and the list of new commits (and the compare link), then ask with the AskUserQuestion tool: "Update Code Viz now?" with the options "Update now", "Not now" (ask again next session) and "Skip this update" (don't ask again until there is a newer commit). If AskUserQuestion is not available, ask the same in plain text and wait.
   - **Update now**: run `CV update apply`. It runs `claude plugin marketplace update` and `claude plugin update` for Code Viz. Report whether it succeeded, and that the new version loads in the next session (or after `/reload-plugins`), with the viewer's server switching over on the first prompt there.
   - **Skip this update**: run `CV update skip <the full latest commit SHA from step 1>`.
   - **Not now**: change nothing.
