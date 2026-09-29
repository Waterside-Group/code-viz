'use strict';
// Update check: is there a newer commit on the repository's main branch than the one this copy
// of Code Viz was installed from?
//
//  - Installed commit: Claude Code records it (gitCommitSha) in plugins/installed_plugins.json
//    for a plugin installed from a git-hosted marketplace. plugin.json has no "version", so
//    Claude Code versions the plugin by commit and `claude plugin update` installs any new one.
//  - Latest commit: `git ls-remote <repo> refs/heads/main`, a public read with no sign-in and
//    no API rate limit, with a hard timeout. When there is something new, a shallow fetch into
//    Code Viz's own cache repository lists the commits in between.
//  - The result is cached in ~/.claude/code-viz/update.json and checked at most every
//    updateCheckIntervalHours. Offline or slow, it fails quietly.
//  - Updating runs Claude Code's own commands: `claude plugin marketplace update <marketplace>`
//    then `claude plugin update code-viz@<marketplace>`.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_REPO = 'https://github.com/Waterside-Group/code-viz';
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const SHA = /^[0-9a-f]{40}$/;
const MAX_COMMITS = 10;

function run(cmd, args, { timeout = 3000, cwd } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, cwd, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' } }, (err, stdout, stderr) =>
      resolve({ ok: !err, code: err ? err.code : 0, killed: !!(err && err.killed), stdout: String(stdout || ''), stderr: String(stderr || '') })
    );
  });
}
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
const short = (sha) => (sha ? String(sha).slice(0, 7) : '');

// Where this copy came from: the marketplace it was installed from, the commit, and the
// repository to compare against. `local` is set for a copy loaded in place (a local
// marketplace directory or --plugin-dir), which Claude Code doesn't update.
function install() {
  const cache = path.join(CLAUDE_DIR, 'plugins', 'cache') + path.sep;
  const info = { root: ROOT, marketplace: null, plugin: 'code-viz', commit: null, repo: DEFAULT_REPO, ref: 'main', local: false };
  if (!ROOT.startsWith(cache)) {
    info.local = true;
    return info;
  }
  const parts = ROOT.slice(cache.length).split(path.sep);
  info.marketplace = parts[0] || null;
  info.plugin = parts[1] || 'code-viz';
  const installed = readJSON(path.join(CLAUDE_DIR, 'plugins', 'installed_plugins.json'), {});
  const entries = (installed.plugins && installed.plugins[`${info.plugin}@${info.marketplace}`]) || [];
  const mine = entries.find((e) => e && path.resolve(String(e.installPath || '')) === ROOT) || entries[0];
  if (mine && SHA.test(String(mine.gitCommitSha || ''))) info.commit = mine.gitCommitSha;
  const known = readJSON(path.join(CLAUDE_DIR, 'plugins', 'known_marketplaces.json'), {});
  const src = known[info.marketplace] && known[info.marketplace].source;
  // A marketplace added from a local directory or file follows that copy, not the repository.
  if (src && (src.source === 'directory' || src.source === 'file')) info.local = true;
  if (src && src.source === 'github' && typeof src.repo === 'string') info.repo = `https://github.com/${src.repo}`;
  else if (src && src.source === 'git' && typeof src.url === 'string') info.repo = src.url;
  if (src && typeof src.ref === 'string' && src.ref) info.ref = src.ref;
  return info;
}

class Updater {
  constructor({ home, settings, version }) {
    this.home = home;
    this.file = path.join(home, 'update.json');
    this.settings = settings;
    this.version = version;
  }

  state() {
    return readJSON(this.file, {});
  }
  save(st) {
    fs.mkdirSync(this.home, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(st, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
  }

  repoUrl(inst) {
    // CODE_VIZ_UPDATE_URL points the check at another repository (used by the tests).
    return process.env.CODE_VIZ_UPDATE_URL || inst.repo;
  }

  // The check. `force` ignores the interval. `budget` caps the time spent on the network.
  async check({ force = false, budget = 3000 } = {}) {
    const cfg = this.settings.load();
    const inst = install();
    const st = this.state();
    const url = this.repoUrl(inst);
    const now = Date.now();
    const result = { checked: false, available: false, installed: inst.commit || st.baseline || null, remote: st.remote || null, mode: cfg.updateOn, marketplace: inst.marketplace, local: inst.local, repo: url.replace(/\.git$/, ''), ref: inst.ref };
    if (inst.local && !process.env.CODE_VIZ_UPDATE_URL) return { ...result, reason: 'local' };
    const fresh = st.checkedAt && st.url === url && now - st.checkedAt < cfg.updateCheckIntervalHours * 3600e3;
    if (!force && fresh) return this.decide({ ...result, remote: st.remote, commits: st.commits, remoteVersion: st.remoteVersion, cached: true }, st);

    const t0 = Date.now();
    const ls = await run('git', ['ls-remote', url, `refs/heads/${inst.ref}`], { timeout: budget });
    const remote = (ls.stdout.split(/\s/)[0] || '').trim();
    if (!ls.ok || !SHA.test(remote)) {
      st.error = ls.killed ? 'timed out' : (ls.stderr.trim().split('\n').pop() || 'no answer').slice(0, 200);
      st.errorAt = now;
      this.save(st);
      return { ...result, error: st.error };
    }
    // No installed commit is known (Claude Code didn't record one): take the current head as
    // the starting point, so only commits from now on count as updates.
    if (!result.installed) {
      st.baseline = remote;
      result.installed = remote;
    }
    let commits = st.remote === remote && st.installed === result.installed ? st.commits : null;
    let remoteVersion = st.remote === remote ? st.remoteVersion : null;
    if (remote !== result.installed && (!commits || (cfg.updateOn === 'version' && !remoteVersion))) {
      const left = Math.max(1000, budget - (Date.now() - t0));
      ({ commits, remoteVersion } = await this.fetchRange(url, inst.ref, result.installed, remote, left));
    }
    Object.assign(st, { checkedAt: now, url, remote, installed: result.installed, commits: commits || null, remoteVersion: remoteVersion || null, error: null });
    this.save(st);
    return this.decide({ ...result, checked: true, remote, commits, remoteVersion }, st);
  }

  // Commit subjects between the installed and the latest commit, and the latest version.json,
  // from a shallow fetch into Code Viz's own bare repository (never Claude Code's copy).
  async fetchRange(url, ref, from, to, budget) {
    const repo = path.join(this.home, 'update-cache.git');
    if (!fs.existsSync(path.join(repo, 'HEAD'))) {
      const init = await run('git', ['init', '--bare', '--quiet', repo], { timeout: 2000 });
      if (!init.ok) return {};
    }
    const f = await run('git', ['-C', repo, 'fetch', '--quiet', '--depth=50', '--no-tags', url, `+refs/heads/${ref}:refs/heads/latest`], { timeout: budget });
    if (!f.ok) return {};
    const out = {};
    const v = await run('git', ['-C', repo, 'show', `${to}:plugins/code-viz/version.json`], { timeout: 1000 });
    try { out.remoteVersion = String(JSON.parse(v.stdout).version || '') || null; } catch {}
    const has = await run('git', ['-C', repo, 'cat-file', '-e', `${from}^{commit}`], { timeout: 1000 });
    const range = has.ok ? `${from}..${to}` : to;
    const log = await run('git', ['-C', repo, 'log', '--format=%H%x09%s', `-n${MAX_COMMITS + 1}`, range], { timeout: 1000 });
    if (log.ok) {
      const list = log.stdout.split('\n').filter(Boolean).map((l) => {
        const [sha, ...s] = l.split('\t');
        return { sha: short(sha), subject: s.join('\t').replace(/[\u0000-\u001f"\\`]/g, ' ').trim().slice(0, 100) };
      });
      out.commits = { list: list.slice(0, MAX_COMMITS), more: list.length > MAX_COMMITS, complete: has.ok };
    }
    return out;
  }

  // Whether to offer the update, per updateOn and a skipped commit.
  decide(r, st) {
    const cfg = this.settings.load();
    r.skipped = !!(st.skip && st.skip === r.remote);
    let newer = !!(r.remote && r.installed && r.remote !== r.installed);
    // The installed commit is in the fetched history and nothing comes after it: not behind.
    if (r.commits && r.commits.complete && !r.commits.list.length) newer = false;
    if (cfg.updateOn === 'version') r.available = newer && !!r.remoteVersion && semverNewer(r.remoteVersion, this.version);
    else r.available = newer;
    r.offer = r.available && !r.skipped && cfg.checkForUpdates;
    const gh = /^https:\/\/github\.com\/[^/]+\/[^/]+/.exec(String(r.repo || '').replace(/\.git$/, ''));
    r.compare = gh && r.remote && r.installed ? `${gh[0]}/compare/${short(r.installed)}...${short(r.remote)}` : null;
    return r;
  }

  skip(sha) {
    const st = this.state();
    st.skip = sha || st.remote || null;
    this.save(st);
    return st.skip;
  }

  // Run Claude Code's own update commands for this plugin.
  async apply() {
    const inst = install();
    if (inst.local) throw new Error(`this copy of Code Viz is loaded from ${ROOT}, not installed from a marketplace, so Claude Code doesn't update it (update it with git pull there)`);
    const claude = process.env.CODE_VIZ_CLAUDE || process.env.CLAUDE_CODE_EXECPATH || 'claude';
    const steps = [
      ['plugin', 'marketplace', 'update', inst.marketplace],
      ['plugin', 'update', `${inst.plugin}@${inst.marketplace}`],
    ];
    const log = [];
    for (const args of steps) {
      const r = await run(claude, args, { timeout: 120000 });
      const text = (r.stdout + '\n' + r.stderr).replace(/\x1b\[[0-9;]*m/g, '').trim();
      log.push({ command: `claude ${args.join(' ')}`, ok: r.ok, output: text.split('\n').slice(-3).join('\n') });
      if (!r.ok) return { ok: false, log };
    }
    const after = install();
    const st = this.state();
    const before = inst.commit;
    if (after.commit) {
      st.installed = after.commit;
      if (st.remote === after.commit) st.skip = null;
      this.save(st);
    }
    return { ok: true, log, from: before, to: after.commit, changed: !!(after.commit && after.commit !== before) };
  }
}

function semverNewer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

module.exports = { Updater, install, short };
