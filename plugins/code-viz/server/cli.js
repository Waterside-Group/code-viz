#!/usr/bin/env node
'use strict';
// code-viz: control the local server and live streaming.
//
//   code-viz status                 server and live-streaming status
//   code-viz start | stop | restart
//   code-viz open                   open the viewer in your default browser
//   code-viz url                    start the server if needed and print the viewer URL
//   code-viz demo                   play the demo in any open viewer
//   code-viz config                 show the config file path and the effective settings
//   code-viz setup ...              first-run setup (see setup() below and /code-viz:setup)
//   code-viz live on  [--project <dir>]
//   code-viz live off [--project <dir>]
//
// Live streaming points Claude Code's ANTHROPIC_BASE_URL at the Code Viz proxy (user settings,
// or a project's .claude/settings.local.json with --project). The proxy forwards every request
// unchanged to the real API and reads Write/Edit tool input as it streams back.

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn, execFile } = require('child_process');
const settings = require('./config');

const ROOT = path.resolve(__dirname, '..');
const VERSION = require(path.join(ROOT, '.claude-plugin', 'plugin.json')).version;
const PORT = settings.load().port;
const HOME = settings.HOME;
const CONFIG = settings.FILE;
const LOG = path.join(HOME, 'server.log');
const PROXY_URL = `http://127.0.0.1:${PORT}`;
const VIEWER_URL = `http://localhost:${PORT}`;
const USER_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const OUR_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(method, p, timeout = 1000) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, timeout, headers: { 'x-code-viz': '1', 'x-code-viz-version': VERSION } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

// null: nothing listening. { foreign: true }: something else owns the port.
async function health() {
  const r = await request('GET', '/__cv/health');
  if (!r) return null;
  try {
    const j = JSON.parse(r.body);
    if (j.name === 'code-viz') return j;
  } catch {}
  return { foreign: true };
}

function readJSON(file, fallback) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return fallback; }
  if (!raw.trim()) return fallback;
  return JSON.parse(raw);
}
function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.code-viz-${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
function hostOf(url) {
  try { return new URL(url).host.toLowerCase(); } catch { return ''; }
}
function isOurs(url) {
  return typeof url === 'string' && OUR_HOSTS.has(hostOf(url));
}

// True when version a is newer than b.
function newer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

async function start({ quiet } = {}) {
  const h = await health();
  if (h && h.foreign) throw new Error(`port ${PORT} is in use by another program (set "port" in ${CONFIG}, or CODE_VIZ_PORT, to use a different port)`);
  const cfg = readJSON(CONFIG, {});
  const upstream = new URL(process.env.CODE_VIZ_UPSTREAM || cfg.upstream || 'https://api.anthropic.com').origin;
  if (h && h.version === VERSION && h.upstream === upstream) return h;
  // A session still running an older copy of the plugin must not replace a newer server.
  if (h && newer(h.version, VERSION)) {
    if (!quiet) console.log(`Code Viz ${h.version} is already running (newer than this copy, ${VERSION}); leaving it.`);
    return h;
  }
  if (h) {
    await request('POST', '/__cv/shutdown');
    for (let i = 0; i < 20 && (await health()); i++) await sleep(100);
  }
  fs.mkdirSync(HOME, { recursive: true });
  const out = fs.openSync(LOG, 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], { detached: true, stdio: ['ignore', out, out] });
  child.unref();
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    const up = await health();
    if (up && !up.foreign) {
      if (!quiet) console.log(`Code Viz ${up.version} running at ${VIEWER_URL} (pid ${up.pid})`);
      return up;
    }
  }
  throw new Error(`the server did not start; see ${LOG}`);
}

async function stop() {
  const h = await health();
  if (!h || h.foreign) return console.log('Code Viz is not running.');
  await request('POST', '/__cv/shutdown');
  console.log('Code Viz stopped.');
}

function settingsFile(args) {
  const i = args.indexOf('--project');
  if (i === -1) return USER_SETTINGS;
  const dir = args[i + 1];
  if (!dir) throw new Error('--project needs a directory');
  return path.join(path.resolve(dir), '.claude', 'settings.local.json');
}

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const dir = path.join(HOME, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${path.basename(file)}.${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.copyFileSync(file, dest);
  return dest;
}

async function liveOn(args) {
  const file = settingsFile(args);
  const settings = readJSON(file, {});
  const env = settings.env || {};
  const prev = env.ANTHROPIC_BASE_URL;
  if (isOurs(prev)) {
    await start({ quiet: true });
    return console.log(`Live streaming is already on in ${file}.`);
  }
  // Remember where requests should really go, and what to restore on "live off".
  const cfg = readJSON(CONFIG, {});
  if (prev) cfg.upstream = prev;
  else if (!cfg.upstream) cfg.upstream = 'https://api.anthropic.com';
  cfg.previousBaseUrl = { ...(cfg.previousBaseUrl || {}), [file]: prev || null };
  writeJSON(CONFIG, cfg);
  // Make sure the proxy works before any Claude Code session depends on it.
  await start({ quiet: true });
  const saved = backup(file);
  settings.env = { ...env, ANTHROPIC_BASE_URL: PROXY_URL };
  writeJSON(file, settings);
  console.log(`Live streaming is on: ANTHROPIC_BASE_URL=${PROXY_URL} in ${file}`);
  if (saved) console.log(`Backup of the previous file: ${saved}`);
  console.log(`Requests are forwarded to ${cfg.upstream}; the only change is eager_input_streaming on the Write and Edit tools.`);
  console.log('Takes effect in Claude Code sessions started from now on. Undo with: code-viz live off');
}

async function liveOff(args) {
  const file = settingsFile(args);
  const settings = readJSON(file, {});
  const cur = settings.env && settings.env.ANTHROPIC_BASE_URL;
  if (!isOurs(cur)) return console.log(`Live streaming is not on in ${file}.`);
  const cfg = readJSON(CONFIG, {});
  const prev = cfg.previousBaseUrl && cfg.previousBaseUrl[file];
  backup(file);
  if (prev) settings.env.ANTHROPIC_BASE_URL = prev;
  else delete settings.env.ANTHROPIC_BASE_URL;
  if (!Object.keys(settings.env).length) delete settings.env;
  writeJSON(file, settings);
  if (cfg.previousBaseUrl) {
    delete cfg.previousBaseUrl[file];
    writeJSON(CONFIG, cfg);
  }
  console.log(`Live streaming is off in ${file}. Sessions started from now on talk to the API directly.`);
}

async function status() {
  const h = await health();
  if (!h) console.log(`Server:    not running (port ${PORT})`);
  else if (h.foreign) console.log(`Server:    port ${PORT} is used by another program`);
  else {
    console.log(`Server:    Code Viz ${h.version}, pid ${h.pid}, ${h.viewers} viewer(s) connected`);
    console.log(`Viewer:    ${VIEWER_URL}`);
    console.log(`Upstream:  ${h.upstream}`);
    const last = h.live.lastAt ? `last API request ${Math.round((Date.now() - h.live.lastAt) / 1000)}s ago` : 'no API traffic seen yet';
    console.log(`Proxy:     ${h.live.requests} request(s), ${h.live.streams} live edit stream(s), ${last}`);
    const gh = h.github;
    console.log(`GitHub:    ${!gh ? 'checking (run status again in a moment)' : gh.ok ? `signed in as @${gh.login} (names, avatars and PRs for line authors)` : gh.disabled ? 'off ("github": false in the config); line authors use git names' : gh.missing ? 'gh CLI not installed; line authors use git names' : 'gh CLI not signed in; line authors use git names'}`);
  }
  const cfg = settings.load();
  if (cfg.error) console.log(`Config:    ${cfg.error} (using defaults)`);
  let on = false;
  try { on = isOurs((readJSON(USER_SETTINGS, {}).env || {}).ANTHROPIC_BASE_URL); } catch {}
  console.log(`Live mode: ${on ? 'on' : 'off'} in ${USER_SETTINGS}`);
  console.log(`Log:       ${LOG}`);
}

function openViewer() {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  execFile(cmd, [VIEWER_URL], () => {});
  console.log(`Opening ${VIEWER_URL}`);
}

function showConfig() {
  const cfg = settings.load();
  const { error, ...values } = cfg;
  console.log(`Config file: ${CONFIG}${fs.existsSync(CONFIG) ? '' : ' (not created yet; these are the defaults)'}`);
  if (error) console.log(`Problem:     ${error} (using defaults)`);
  console.log(JSON.stringify(values, null, 2));
  console.log('Environment variables override the file: CODE_VIZ_PORT, CODE_VIZ_AUTO_OPEN, CODE_VIZ_THEME, CODE_VIZ_GITHUB.');
}

// ---------------------------------------------------------------------------
// First-run setup, driven by /code-viz:setup. Claude asks the user before running any step that
// changes something; these commands only do what they are told.
//
//   code-viz setup status             what setup would do: the CLAUDE.md block and GitHub status
//   code-viz setup claude-md add      add (or update) the Code Viz block in the user's CLAUDE.md
//   code-viz setup claude-md remove   remove that block
//   code-viz setup done               record that setup was offered, so it is not offered again

const CLAUDE_MD = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'CLAUDE.md');
const OFFERED = path.join(HOME, 'setup-offered');
const BEGIN = '<!-- code-viz:begin (added by /code-viz:setup; remove it with /code-viz:setup remove) -->';
const BEGIN_RE = /<!-- code-viz:begin\b[^>]*-->/;
const END = '<!-- code-viz:end -->';

function snippet() {
  return [
    BEGIN,
    '# Code Viz',
    '',
    `I use the Code Viz plugin to watch Claude work. In the Claude desktop app, at the start of every session (first thing in your response to my first prompt, whatever it is), make sure the viewer is open: if no browser pane tab is showing ${VIEWER_URL}, open it with the built-in browser's preview_start tool (url \`${VIEWER_URL}\`). Don't reopen it later in the session if it's already open, and don't mention it in your reply. If the page doesn't load, run \`code-viz start\` and try again. Outside the desktop app (no browser pane), skip this.`,
    END,
  ].join('\n');
}

// Where the Code Viz block sits in `text`: { start, end } (end is past END), or null.
function findBlock(text) {
  const m = BEGIN_RE.exec(text);
  if (!m) return null;
  const e = text.indexOf(END, m.index);
  if (e === -1) throw new Error(`${CLAUDE_MD} has a Code Viz begin marker without "${END}". Fix or remove it by hand.`);
  return { start: m.index, end: e + END.length };
}

function readClaudeMd() {
  try { return fs.readFileSync(CLAUDE_MD, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

// Whether the GitHub CLI is installed and signed in to github.com, and as whom. Only the
// account name is read from `gh auth status`; its output never includes the token itself.
function ghStatus() {
  const env = { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' };
  const check = (args) =>
    new Promise((resolve) => {
      execFile('gh', args, { timeout: 15000, env }, (err, stdout, stderr) => resolve({ err, out: `${stdout || ''}\n${stderr || ''}` }));
    });
  return (async () => {
    // --active (gh 2.40+) checks only the account gh uses, so a stale second login doesn't count.
    let r = await check(['auth', 'status', '--hostname', 'github.com', '--active']);
    if (r.err && r.err.code === 'ENOENT') return { installed: false, signedIn: false };
    if (r.err && /unknown flag/i.test(r.out)) r = await check(['auth', 'status', '--hostname', 'github.com']);
    const m = /Logged in to github\.com (?:account|as) ([A-Za-z0-9-]+)/.exec(r.out);
    return { installed: true, signedIn: !r.err, login: m ? m[1] : null };
  })();
}

async function setup(args) {
  const [step, action] = args;
  if (step === 'status' || step === undefined) {
    const text = readClaudeMd();
    let block = null;
    try { block = text == null ? null : findBlock(text); } catch (e) { console.log(`CLAUDE.md problem: ${e.message}`); }
    const current = block ? text.slice(block.start, block.end) : null;
    console.log(`CLAUDE.md:  ${CLAUDE_MD}${text == null ? ' (does not exist yet; it would be created)' : ''}`);
    console.log(`Code Viz block in CLAUDE.md: ${!block ? 'not present' : current === snippet() ? 'present and up to date' : 'present, but different from the current version (add would update it)'}`);
    console.log('The block setup would add (appended at the end of the file):');
    console.log('-----');
    console.log(snippet());
    console.log('-----');
    const gh = await ghStatus();
    console.log(`GitHub CLI: ${!gh.installed ? 'not installed (optional; https://cli.github.com)' : gh.signedIn ? `signed in${gh.login ? ` as @${gh.login}` : ''}` : 'installed, not signed in'}`);
    if (!settings.load().github) console.log('GitHub lookups are turned off in the config ("github": false).');
    console.log(`Session:    ${process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop' ? 'Claude desktop app' : 'not the Claude desktop app (the CLAUDE.md block only has an effect in the desktop app)'}`);
    console.log(`Auto-open:  ${settings.load().autoOpen ? 'on (the SessionStart hook already asks Claude to open the viewer in the desktop app)' : 'off'}`);
    return;
  }
  if (step === 'claude-md' && (action === 'add' || action === 'remove')) {
    const text = readClaudeMd();
    const block = text == null ? null : findBlock(text);
    if (action === 'add') {
      let next;
      if (block) next = text.slice(0, block.start) + snippet() + text.slice(block.end);
      else if (!text || !text.trim()) next = snippet() + '\n';
      else next = text.replace(/\s*$/, '\n\n') + snippet() + '\n';
      if (next === text) return console.log(`The Code Viz block in ${CLAUDE_MD} is already up to date. Nothing changed.`);
      const saved = backup(CLAUDE_MD);
      fs.mkdirSync(path.dirname(CLAUDE_MD), { recursive: true });
      fs.writeFileSync(CLAUDE_MD, next);
      console.log(`${block ? 'Updated the Code Viz block in' : 'Added the Code Viz block to'} ${CLAUDE_MD}.`);
      if (saved) console.log(`Backup of the previous file: ${saved}`);
      return;
    }
    if (!block) return console.log(`There is no Code Viz block in ${CLAUDE_MD}. Nothing changed.`);
    const before = text.slice(0, block.start).replace(/\n*$/, '');
    const after = text.slice(block.end).replace(/^\n*/, '');
    const next = before && after ? `${before}\n\n${after}` : before ? `${before}\n` : after;
    const saved = backup(CLAUDE_MD);
    fs.writeFileSync(CLAUDE_MD, next);
    console.log(`Removed the Code Viz block from ${CLAUDE_MD}.`);
    if (saved) console.log(`Backup of the previous file: ${saved}`);
    return;
  }
  if (step === 'done') {
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(OFFERED, new Date().toISOString() + '\n');
    return console.log('Setup marked as done; Code Viz will not offer it again.');
  }
  throw new Error('usage: code-viz setup status | claude-md add | claude-md remove | done');
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'start':
      return start();
    case 'stop':
      return stop();
    case 'restart':
      await stop();
      await sleep(300);
      return start();
    case 'status':
    case undefined:
      return status();
    case 'open':
      await start({ quiet: true });
      return openViewer();
    case 'url':
      await start({ quiet: true });
      return console.log(VIEWER_URL);
    case 'config':
      return showConfig();
    case 'setup':
      return setup(args);
    case 'demo':
      await start({ quiet: true });
      await request('POST', '/__cv/demo');
      return console.log('Demo started. Watch it at ' + VIEWER_URL);
    case 'live':
      if (args[0] === 'on') return liveOn(args.slice(1));
      if (args[0] === 'off') return liveOff(args.slice(1));
      throw new Error('usage: code-viz live on|off [--project <dir>]');
    default:
      throw new Error(`unknown command "${cmd}". Commands: status, start, stop, restart, open, url, demo, config, setup, live on|off`);
  }
}

main().catch((e) => {
  console.error('code-viz: ' + e.message);
  process.exit(1);
});
