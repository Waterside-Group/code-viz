# Code Viz

Watch Claude work. Code Viz is a [Claude Code](https://code.claude.com) plugin that runs a small viewer on your machine, at <http://localhost:4455>, with two views:

- **Activity**: a live feed of everything Claude does. Your prompts, each thinking block ("Thought for 8s"), Claude's replies, and every tool call as a card: shell commands and CLIs (git, npm, GitHub, curl, psql and more), MCP calls (database queries show the returned rows as a table), file reads and searches. A card shows a spinner and a running clock while its tool runs, then its duration and output, or the error. Between tool calls a "Thinking" row counts up, so you can see Claude is working before anything is written.
- **Code**: the file Claude is editing, with every change animated. New code is typed in with a caret, removed lines turn red and fold away, small edits are backspaced and retyped in place, and changed lines keep a marker in the gutter. Next to the line numbers, a column shows who last changed each line.

Tool calls get **screens** of their own: shell commands type out on a 1990 phosphor terminal and stream their output, and web searches and page fetches load in a browser window. See [Tool screens](#tool-screens).

With **Follow** on (the target button in the footer), the viewer switches to the code when Claude edits a file (or to the screen when it runs a command or searches) and back to the feed when it moves on. Wide windows (1100px and up) show both side by side.

A **usage** strip under the header shows the plan's 5-hour session (how much is used, when it resets, and an ETA at the current pace) and expands to token totals for each repository Claude is working in. See [Token usage](#token-usage).

<!-- Screenshot placeholder: add a screenshot of the viewer (for example docs/screenshot.png) and link it here. -->

## Requirements

- Claude Code, in the terminal or the Claude desktop app.
- [Node.js](https://nodejs.org) 18 or newer. Code Viz has no npm dependencies and no install step. It finds `node` on your `PATH`, or in the usual Homebrew, Volta, fnm and nvm locations.
- `curl` and `git` (preinstalled on macOS and most Linux systems).
- Optional: the [GitHub CLI](https://cli.github.com) (`gh`), signed in, to show GitHub names, avatars and pull requests for line authors. See [Line authors](#line-authors).
- macOS or Linux. Windows is untested (the hooks are POSIX shell scripts).

## Install

In Claude Code:

```
/plugin marketplace add Waterside-Group/code-viz
/plugin install code-viz@code-viz
```

Or from your shell:

```bash
claude plugin marketplace add Waterside-Group/code-viz
claude plugin install code-viz@code-viz
```

Then start a new Claude Code session (or run `/reload-plugins`). The server starts by itself with the session.

The first time Code Viz runs, Claude offers to run `/code-viz:setup` once. Setup is optional, and it asks before each step:

1. **CLAUDE.md line** (desktop app): add a short block to your `~/.claude/CLAUDE.md` that tells Claude to open the viewer at the start of every session. See [The CLAUDE.md block](#the-claudemd-block).
2. **GitHub**: if the GitHub CLI is installed but not signed in, offer to run `gh auth login` so line authors show GitHub profiles. You finish the sign-in in your browser. Skipping it is fine.
3. **Plan usage** (terminal sessions): point Claude Code's status line at a small forwarder, so the usage strip can show the real percent of your 5-hour limit. See [Plan usage from the status line](#plan-usage-from-the-status-line).

You can run `/code-viz:setup` again at any time.

## Usage

- **Claude desktop app**: Claude opens the viewer in the browser pane on the right at the start of every session (turn this off with `autoOpen`, see [Configuration](#configuration)).
- **`/code-viz:code-viz`** in any session opens the viewer (the browser pane in the desktop app, your default browser in the terminal). Add `demo` to play a demo: `/code-viz:code-viz demo`.
- **Any browser**: go to <http://localhost:4455>.

The demo edits a made-up project with a made-up team, so you can see every animation and the line authors without a repository.

### The `code-viz` command

The plugin ships a `code-viz` command. Inside Claude Code sessions it is on the `PATH`, so you can ask Claude to run it ("run code-viz status").

```
code-viz status       server, GitHub and live-mode status
code-viz start | stop | restart
code-viz open         open the viewer in your default browser
code-viz url          start the server if needed and print the viewer URL
code-viz demo         play the demo in any open viewer
code-viz config       show the config file path and the effective settings
code-viz update ...   check for a newer commit (check [--force]), install it (apply), or skip it (skip)
code-viz usage        token usage per repo and the 5-hour session, as text
code-viz setup ...    the steps behind /code-viz:setup (status, claude-md add|remove, statusline add|remove, done)
code-viz live on|off [--project <dir>]
```

To run it in your own terminal, use its path in the plugin cache: `~/.claude/plugins/cache/code-viz/code-viz/<version>/bin/code-viz`.

## Configuration

Settings live in `~/.claude/code-viz/config.json`. The file is optional; create it with only the settings you want to change. An environment variable, where one exists, overrides the file. Run `code-viz config` to see the effective values.

```json
{
  "port": 4455,
  "autoOpen": true,
  "theme": "auto",
  "speed": 1,
  "follow": true,
  "wrap": true,
  "authors": true,
  "github": true,
  "usage": true,
  "usagePeriod": "today",
  "sessionTokenBudget": null,
  "burnWindowMinutes": 20
}
```

| Setting | Env variable | Default | What it does |
| --- | --- | --- | --- |
| `port` | `CODE_VIZ_PORT` | `4455` | Port of the viewer (and of the live-mode proxy). The server only listens on `127.0.0.1`. |
| `autoOpen` | `CODE_VIZ_AUTO_OPEN` (`0` or `1`) | `true` | In the desktop app, ask Claude to open the viewer in the browser pane at the start of each session. |
| `theme` | `CODE_VIZ_THEME` | `"auto"` | `"auto"` follows your system, or force `"light"` or `"dark"`. |
| `speed` | | `1` | Default animation speed: `0.5`, `1`, `2` or `4`. |
| `follow` | | `true` | Default for Follow: jump to each file and change as it happens. |
| `wrap` | | `true` | Default for wrapping long lines. |
| `authors` | | `true` | Default for the line-author column. |
| `github` | `CODE_VIZ_GITHUB` (`0` or `1`) | `true` | Look up line authors on GitHub through your `gh` login. `false` keeps Code Viz off the GitHub API entirely. |
| `usage` | | `true` | Default for the usage strip (the gauge button in the footer). Code Viz starts reading transcripts for usage only when a viewer with the strip on (or `code-viz usage`) first asks. |
| `usagePeriod` | | `"today"` | What the per-repo totals cover: `"today"` (since local midnight) or `"window"` (the current 5-hour session). |
| `sessionTokenBudget` | | none | Your own token budget for a 5-hour session, used for an ETA when the plan percent isn't available. Counted like the totals (cache reads excluded). |
| `terminalScreen` | | `true` | Play shell commands (Bash and PowerShell) on the terminal screen. |
| `browserScreen` | | `true` | Play web searches and page fetches on the browser screen. |
| `terminalColor` | | `"green"` | Phosphor color of the terminal: `"green"` or `"amber"`. |
| `screenLines` | | `200` | How many lines of a command's output the terminal keeps (the last ones). 10 to 2000. |
| `burnWindowMinutes` | | `20` | How many recent minutes the pace (tokens per minute, and percent per minute) is measured over. 5 to 120. |
| `upstream` | `CODE_VIZ_UPSTREAM` | `https://api.anthropic.com` | Live mode only: where the proxy forwards requests. `code-viz live on` sets it for you. |
| `eagerStreaming` | `CODE_VIZ_EAGER=0` turns it off | `true` | Live mode only. See [Live mode](#live-mode). |

`speed`, `follow`, `wrap`, `authors` and `usage` are defaults for the footer buttons. Once you click one, the viewer remembers your choice in that browser, and that wins over the file. Viewer settings apply when you reload the page.

Advanced: `CODE_VIZ_HOME` moves the state directory (default `~/.claude/code-viz`), and `CODE_VIZ_PROJECTS` points at a different transcripts folder (default `~/.claude/projects`).

**Changing the port**: run `code-viz stop`, change `port`, then start a new session or run `code-viz start`. If live mode is on, turn it off first (`code-viz live off`) and back on after, since it points Claude Code at the old port.

## Line authors

For files in a git repository, the column next to the line numbers shows who last changed each line, with a color per person. The first line of each run carries a label: the person's photo or initials, their name, and the date and time of the commit. Above the code, a strip shows each person's share of the file; click a name to highlight their lines. Hover a name to see the commit, its date and its pull request. Toggle the column with the people button in the footer.

**What works signed out.** Authors come from `git blame` in your local clone (whitespace changes ignored, moved lines followed, `.git-blame-ignore-revs` honored), so every line gets the name and email of the last person who changed it, with no network and no sign-in. Uncommitted lines Claude wrote show as Claude, and committed lines whose commit has a `Co-Authored-By: Claude` trailer get an orange dot next to the person's name. "Author" means the last person to change the line, not whoever first wrote it.

**What signing in to GitHub adds.** When the GitHub CLI is signed in and the repository's `origin` is on github.com, Code Viz asks GitHub (through `gh api`) which account made each commit and which pull request merged it. That turns git names into GitHub profiles: the display name, `@username` and avatar, plus a link to the pull request. It works for private repositories your account can access. GitHub's GraphQL API only answers signed-in requests, so without `gh` there is no GitHub lookup at all and names come from git. Only pushed commits can be matched; unpushed commits by the same email are matched once one of that person's commits has been.

**Credentials stay with `gh`.** Code Viz never asks for, reads, logs or stores a GitHub token. It runs `gh api` and lets `gh` use its own login. Results (commit to profile and pull request) are cached in `~/.claude/code-viz/github-cache.json`. After you sign in, Code Viz picks it up within 30 seconds.

- Sign in: `gh auth login` (or `/code-viz:setup`).
- Sign out: `gh auth logout`. Code Viz stops asking GitHub within 10 minutes (right away after `code-viz restart`). Profiles it already looked up stay in `github-cache.json`; delete that file to forget them.
- Keep Code Viz off GitHub even while `gh` is signed in: set `"github": false`.

## Tool screens

When Claude runs a command or goes to the web, the stage shows it the way you would see it:

- **Terminal** (the Bash and PowerShell tools): the stage becomes a green or amber phosphor screen from around 1990, edge to edge, with scanlines, a soft flicker and glow, and a blinking block cursor. A status line at the top names the program and the working directory. Claude's description of the command appears as a comment, the command types out at the prompt, a cursor waits while it runs (with a running clock), then the output streams in below it, stderr tinted, and the exit status: `[exit 0 · 1.2s]`, `[exit 1 · 0.4s]` in inverse video, `^C [interrupted]`, or a note for commands sent to the background.
- **Browser** (WebSearch and WebFetch): the query or URL types into the address bar, a loading bar runs until the result is in, then the page renders. A search shows each result's title, domain and URL, plus the summary text that came back with the results. A fetch shows the domain, the HTTP status and size, what Claude asked about the page, and the answer it got.

**What counts as a CLI.** Every shell command gets the terminal. The title bar names the program that matters in the command line, the same way the activity feed does: `git status`, `GitHub CLI pr`, `npm test`, `curl api.example.com`, `xcodebuild`, or the program's own name, or `sh`. MCP tool calls don't get a screen: they are often rapid-fire (a browser automation can make dozens of calls a minute), which would make the stage flicker and hold up file edits, and their card in the activity feed already shows the call, its input and its result.

**Playing, replaying and skipping.** Screens queue with file edits and play in order, at the speed set in the footer. A long-running command doesn't hold the queue: if other work is waiting, the edit plays, and the command's output plays when it arrives. Each screen gets a tick in the timeline (green for commands, purple for the web); click one to replay it. While a screen plays, **Skip** jumps to its end; afterwards, **Replay** plays it again. The Terminal or Browser tab reopens the last screen, and clicking a command's card in the feed opens its screen. With reduced motion turned on in your system settings, screens show their text at once, without typing, flicker or the power-on effect.

**Where the data comes from.** The `PreToolUse` hook starts a screen (the command, query or URL), and `PostToolUse` or `PostToolUseFailure` finishes it (stdout and stderr, or the failure text and its `Exit code N` line; the search results; the fetch status and answer). Search results carry titles and URLs only, so there are no per-result snippets.

**Kept local, capped and redacted.** Screens exist only in the local viewer and in the server's memory (the last 100). Output keeps the last `screenLines` lines, each cut at 400 characters. Before anything is stored or shown, Code Viz redacts obvious secrets from commands, output, queries, URLs and summaries, and from the tool cards in the activity feed as well:

- tokens with a known shape: Anthropic, OpenAI, GitHub, GitLab, Slack, AWS access keys, Google API keys, Stripe, npm and Supabase tokens, JWTs, and private key blocks;
- `Authorization`, `Cookie` and API-key headers, and `Bearer` tokens;
- `.env` and shell style `NAME=value` where the name contains a secret word (`SECRET`, `TOKEN`, `PASSWORD`, `API_KEY`, `ACCESS_KEY`, `PRIVATE_KEY`, `CLIENT_SECRET`, `CREDENTIALS`, `DATABASE_URL`, `DSN` and similar), and the same names as JSON or YAML keys;
- credentials inside URLs (`https://user:pass@host`) and secret query parameters (`token`, `access_token`, `api_key`, `key`, `secret`, `password`, `signature` and similar).

Redaction is a safety net for common shapes, not a guarantee; a secret in an unusual format can still show. Turn a screen type off with `terminalScreen` or `browserScreen`.

## Token usage

The usage strip sits under the header. Collapsed, it is one line: the session gauge, when the session resets, and the ETA with the current pace. Click it to expand the totals per repository. Toggle the whole strip with the gauge button in the footer, or run `code-viz usage` for the same numbers as text.

**Per repository.** Claude Code writes the token usage of every reply into its session transcripts (`~/.claude/projects/`). Code Viz adds them up by repository: each session's working directory is mapped to its git repository, and git worktrees (including the ones the desktop app creates under `.claude/worktrees/`) count toward their main repository. Several repositories and several sessions at once, including subagents, all show up; a dot marks repositories with a reply in the last 5 minutes. Hover a row for its path, session count and models.

- Each row shows **input**, **output**, **cache write** and **cache read** tokens, and a **total**.
- **The total is input + output + cache writes. Cache reads are listed but not added in.** Cache reads are Claude re-reading context it already has, and in long sessions they are routinely 100 times everything else combined, so a total that included them would say little about the work done. They are still shown on every row.
- By default the totals cover today (since local midnight); set `usagePeriod` to `"window"` for the current 5-hour session.
- Code Viz reads the transcripts incrementally (backwards to 24 hours ago on first open, then only new bytes) and counts each reply once, even though Claude Code writes a reply's usage on several lines. From each line it takes only the usage numbers, the model, the time, the working directory and ids. It never keeps, logs or shows message content from this, and the numbers stay on your machine.
- The counts are Claude Code on this machine only. Usage from claude.ai, the Claude apps and other computers isn't in them.

**The 5-hour session.** Plan limits (the 5-hour session and the weekly limit) are not in transcripts or in hook input. Claude Code shares them in one place: the JSON it passes to a status line command (`rate_limits.five_hour` and `rate_limits.seven_day`, each with `used_percentage` and `resets_at`), for Pro and Max subscribers, after the first reply of a session. So there are two cases:

- **With the status line forwarder** (see below), the strip shows the real numbers: "Session 43% used · resets 12:03 PM · week 61%". The ETA is how fast that percentage has risen over the last `burnWindowMinutes`, projected to 100%, and it says "Lasts until reset" when that would come after the reset time. Plan usage is shared across your devices and Claude apps, so this is the true figure, and one terminal session with the forwarder keeps it current for every viewer.
- **Without it** (for example in the desktop app only), Code Viz does not invent a limit. It shows the tokens used in the current session and when that session most likely resets, estimated from this machine's activity: a session starts with the first reply after the previous one ended, rounded down to the hour, and lasts 5 hours (the rounding is an approximation). The pace is shown in tokens per minute. For an ETA, set `sessionTokenBudget` to a number of your own; the strip then shows how much of that budget is used and when it would run out at the current pace, clearly labelled as an estimate against your number.

### Plan usage from the status line

`/code-viz:setup` (step 3) or `code-viz setup statusline add` sets Claude Code's `statusLine` in `~/.claude/settings.json` to `~/.claude/code-viz/statusline.sh`, after saving a backup to `~/.claude/code-viz/backups/`. On every status line update the forwarder sends the status line data to the local Code Viz server, which keeps only the `rate_limits` numbers, and prints a short line such as `5h 43% · resets 12:03 PM · 7d 61%`. If you already had a status line command, the forwarder runs it instead and prints its output, so your status line looks the same. `code-viz setup statusline remove` restores exactly what was there before.

Status line commands are a terminal feature, so this feeds the numbers only while you use Claude Code in a terminal. The desktop app has its own usage ring next to the model picker.

## The CLAUDE.md block

`/code-viz:setup` can add this block to your `~/.claude/CLAUDE.md`, only after you say yes (the port matches your config):

```markdown
<!-- code-viz:begin (added by /code-viz:setup; remove it with /code-viz:setup remove) -->
# Code Viz

I use the Code Viz plugin to watch Claude work. In the Claude desktop app, at the start of every session (first thing in your response to my first prompt, whatever it is), make sure the viewer is open: if no browser pane tab is showing http://localhost:4455, open it with the built-in browser's preview_start tool (url `http://localhost:4455`). Don't reopen it later in the session if it's already open, and don't mention it in your reply. If the page doesn't load, run `code-viz start` and try again. Outside the desktop app (no browser pane), skip this.
<!-- code-viz:end -->
```

**Most people don't need it.** The plugin's SessionStart hook already gives Claude the same instruction in every desktop session while `autoOpen` is on. When the block is in your CLAUDE.md, the hook stops adding its own copy, so Claude never gets it twice. The block is for people who want the instruction in their own CLAUDE.md, where they can see and reword it. The trade-off: it stays in your CLAUDE.md if you disable or uninstall the plugin, so remove it first.

- The markers let setup find the block: running setup again updates it in place, and it never adds a second copy.
- `/code-viz:setup remove` (or `code-viz setup claude-md remove`) takes it out and leaves the rest of the file as it was.
- Every change saves a backup of the previous file in `~/.claude/code-viz/backups/`.

## Live mode

By default, each edit is replayed the moment Claude saves it. Terminal sessions can go further and stream edits, thinking and tool input token by token, through a local proxy:

```bash
code-viz live on      # route Claude Code's API traffic through the local proxy
code-viz live off     # back to direct
```

`live on` sets `ANTHROPIC_BASE_URL=http://127.0.0.1:4455` in `~/.claude/settings.json` (or in a project's `.claude/settings.local.json` with `--project <dir>`). It saves a backup to `~/.claude/code-viz/backups/` first. Sessions started after that stream live.

**The Claude desktop app ignores this.** It sets its own `ANTHROPIC_BASE_URL` for each session, which overrides `settings.json`, so desktop sessions never go through the proxy. They still get the activity feed (hooks and transcripts), and edits replay the moment they are saved.

What to know before turning it on:

- **Every API request from Claude Code goes through the proxy.** It forwards requests to `https://api.anthropic.com` (or whatever base URL you had before), including your auth headers, and streams responses back unchanged. It only listens on `127.0.0.1` and doesn't log request or response bodies.
- **It changes one thing in requests:** it sets `eager_input_streaming: true` on the `Write` and `Edit` tool definitions of streaming requests. Without it, the API holds back each tool parameter until it's complete, so a file's contents would arrive in one burst instead of streaming. If the upstream ever rejects the field, the proxy resends the request untouched and stops adding it. To turn it off, set `"eagerStreaming": false` in the config.
- **If the proxy isn't running, Claude Code can't reach the API.** The plugin's `SessionStart` and `UserPromptSubmit` hooks restart it automatically. If you uninstall or disable the plugin, run `code-viz live off` first.
- If you use a custom gateway, Bedrock or Vertex, leave live mode off.

## How it works

| Source | What it gives | Latency |
| --- | --- | --- |
| Hooks (`PreToolUse`/`PostToolUse` on every tool, `UserPromptSubmit`, `Stop`) | Tool calls starting and finishing, file snapshots around every `Write`/`Edit`, prompts, turn ends | Real time |
| Session transcripts (`~/.claude/projects/*/*.jsonl`) | Thinking, replies, prompts, and recent history when the viewer opens | Each block appears when Claude finishes it, usually within a second |
| API proxy (opt-in live mode, terminal sessions only) | Edits, thinking and tool input token by token | Real time |

The hooks forward each event to the server with `curl` and always exit successfully without printing anything, so they can't block or slow a tool call or add to Claude's context. The server (plain Node.js, no dependencies) merges the three sources into one feed and pushes it to the viewer over Server-Sent Events. If the server isn't running, the next hook starts it. A session that started with an older copy of the plugin never replaces a newer server.

**What stays local, and what doesn't.** The server listens on `127.0.0.1` only and rejects requests with a foreign `Host` or `Origin`, so web pages can't read it. It only serves files Claude has touched in a session. It reads your session transcripts and the files Claude edits. The usage strip reads only usage numbers from the transcripts (see [Token usage](#token-usage)). Network requests: the viewer loads highlight.js from cdnjs for syntax highlighting, avatars load from GitHub, the GitHub lookups above run through `gh` when signed in, the update check reads the repository's latest commit from GitHub (see [Updates](#updates)), and live mode forwards API traffic as described. Nothing else leaves your machine.

State lives in `~/.claude/code-viz/`: `config.json`, `server.log`, `server.pid`, `claude-lines.json` (lines Claude wrote, so uncommitted lines are credited correctly), `github-cache.json`, `backups/`, `setup-offered` (so setup is offered only once), `update.json` and `update-cache.git` (the update check), and, if you set the status line forwarder, `statusline.sh` and `statusline-previous.*` (your previous status line, for restoring it). Token usage and plan usage are kept in memory only.

### Layout

```
.claude-plugin/marketplace.json   the marketplace (one plugin)
plugins/code-viz/
  .claude-plugin/plugin.json
  hooks/hooks.json                SessionStart, UserPromptSubmit, Pre/PostToolUse (every tool), failures, Stop
  scripts/                        hook.sh (curl forwarder), ensure-server.sh, session-start.sh, common.sh, statusline.sh
  commands/code-viz.md            /code-viz:code-viz
  commands/setup.md               /code-viz:setup
  commands/update.md              /code-viz:update
  version.json                    Code Viz's release number (plugin.json has none; see Updates)
  bin/code-viz                    CLI (on PATH in Claude Code sessions)
  server/server.js                hook receiver, API proxy + stream tap, SSE to the viewer
  server/config.js                settings: config file, environment, defaults
  server/cli.js                   the code-viz command, including setup
  server/activity.js              the activity feed: tool classification, merging hooks, transcripts and proxy
  server/transcripts.js           follows session transcripts (hook paths, a folder watch, a startup scan)
  server/blame.js                 line authors: git blame, plus GitHub identities via gh
  server/usage.js                 token usage per repo from transcripts, and the 5-hour session
  server/screens.js               terminal and browser screens from hook events
  server/redact.js                removes obvious secrets from commands and output
  server/update.js                the update check and the update itself
  server/partial-json.js          incremental parser for streamed tool input
  server/demo.js                  the demo
  server/viewer/                  the viewer (index.html, app.js, style.css, diff.js)
```

## Troubleshooting

- **The viewer doesn't load.** Ask Claude to run `code-viz status`, or look at `~/.claude/code-viz/server.log`. "node was not found" means Node.js 18+ isn't installed or isn't in a standard location. "port 4455 is in use by another program" means something else has the port: set `port` in the config.
- **The feed stays empty.** Hooks load when a session starts, so start a new session (or run `/reload-plugins`) after installing or updating.
- **Claude never asks about updates.** Run `code-viz update check --force`. It says whether you're up to date, whether you skipped the latest commit, or why it couldn't check (offline, or a copy loaded from a local directory).
- **The desktop app doesn't open the viewer.** Check that `autoOpen` isn't off (`code-viz config`). You can always run `/code-viz:code-viz`.
- **Line authors show git names, not GitHub profiles.** Run `gh auth status`. Signing in is optional; see [Line authors](#line-authors). Profiles only appear for commits pushed to a github.com repository.
- **No syntax highlighting.** highlight.js loads from cdnjs; without network the code shows as plain text.
- **The usage strip says the plan percent isn't available.** Claude Code only passes plan usage to status line commands, in terminal sessions, for Pro and Max subscribers. Set the forwarder (`code-viz setup statusline add`), then send a message in a terminal session. Until then, token totals and the estimated session still work.
- **Usage totals look lower than expected.** They count only Claude Code on this machine, and the total leaves out cache reads (shown separately on each row).
- **Claude Code can't reach the API after disabling the plugin.** Live mode is still on: run `code-viz live off`, or remove `ANTHROPIC_BASE_URL` from the `env` block of `~/.claude/settings.json`.

## Limits

- Only `Write` and `Edit` are animated in the code view. Changes made through Bash (`sed`, formatters, `git checkout`) appear as commands on the terminal and in the feed, not as edits.
- The terminal shows a command's output when it finishes, not while it runs: Claude Code's hooks report the output only at the end.
- Without live mode, thinking can't stream token by token: a thinking block appears once Claude finishes it. The "Thinking" row shows that Claude is working in the meantime.
- The feed reads every recent session on this machine, so parallel sessions show up together, labeled by project.
- Uncommitted lines are credited to Claude only if Code Viz saw Claude write them; other uncommitted lines go to your git user.
- Files over 2 MB and binary files are skipped.

## Updates

**Code Viz checks for updates at the start of a session.** Any new commit on the repository's `main` branch counts as an update. When there is one, Claude asks you once in that session, showing the installed and the latest commit and the commit subjects in between, with three choices:

- **Update now**: Claude runs `code-viz update apply`, which runs Claude Code's own update commands for this marketplace and plugin and confirms the new commit is installed:

  ```bash
  claude plugin marketplace update code-viz
  claude plugin update code-viz@code-viz
  ```

  The new version loads in your next session (or after `/reload-plugins`), and the viewer's server switches over on the first prompt there.
- **Not now**: nothing changes; you're asked again next session.
- **Skip this update**: you aren't asked again until a newer commit lands.

Run `/code-viz:update` to check and update on demand, or `code-viz update check` for the status as text.

How it works:

- The installed commit is the one Claude Code recorded when it installed or last updated the plugin. The latest commit comes from `git ls-remote https://github.com/Waterside-Group/code-viz refs/heads/main`: a public read with no sign-in and no API rate limit. When they differ, Code Viz fetches the last 50 commits of `main` into its own small cache repository (`~/.claude/code-viz/update-cache.git`) to list the commits in between; it never touches Claude Code's copy of the marketplace.
- The check has a hard time limit of a couple of seconds, fails quietly when you're offline, and runs at most every `updateCheckIntervalHours` (6 by default). The result is kept in `~/.claude/code-viz/update.json`.
- `plugin.json` deliberately has no `version`, so Claude Code versions Code Viz by commit and `claude plugin update` installs every new commit. (With a version in `plugin.json`, Claude Code would ignore new commits until the version changed.) Code Viz's own release number is in `plugins/code-viz/version.json`. Because of this, `claude plugin validate` passes with one warning ("No version specified"), and `--strict` reports it as an error.
- Claude Code also has a built-in background auto-update, which is off for marketplaces like this one until you turn it on: `/plugin`, **Marketplaces**, select `code-viz`, **Enable auto-update**. With it on, Claude Code updates Code Viz by itself after a session starts, and you can set `checkForUpdates` to `false`.

| Setting | Env variable | Default | What it does |
| --- | --- | --- | --- |
| `checkForUpdates` | `CODE_VIZ_CHECK_UPDATES` (`0` or `1`) | `true` | Check for updates at session start. |
| `updateCheckIntervalHours` | | `6` | Check at most this often. `0` checks every session. |
| `updateOn` | | `"commit"` | `"commit"`: any new commit on `main` is an update, including commits that only change the README or docs. `"version"`: only a new release number in `version.json`, the quieter choice. |

A copy loaded from a local directory (a marketplace added as a folder, or `--plugin-dir`) isn't updated by Claude Code, so Code Viz doesn't offer updates for it; update it with `git pull`.

## Uninstall

1. If you turned on live mode, run `code-viz live off` first. Otherwise Claude Code keeps sending API requests to a proxy that is no longer there.
2. If you added the CLAUDE.md block, run `/code-viz:setup remove`.
3. If you set the status line forwarder, run `code-viz setup statusline remove`.
4. Run `code-viz stop`.
5. Remove the plugin and the marketplace:

   ```bash
   claude plugin uninstall code-viz@code-viz
   claude plugin marketplace remove code-viz
   ```

6. Optionally delete `~/.claude/code-viz/` (settings, logs, caches and backups).

## License

[MIT](LICENSE)
