'use strict';
// Activity feed: every prompt, thinking block, reply and tool call, merged from three sources
// that overlap and arrive out of order.
//
//  - Hooks (Pre/PostToolUse on every tool): the only real-time signal. A tool call appears the
//    moment it starts and is marked done the moment it finishes.
//  - Session transcripts: thinking text, replies and prompts. Claude Code stamps each line
//    when its block finishes but only writes them to disk after the next tool runs, so a
//    thinking block arrives a beat late. Items carry their own timestamps and the viewer
//    orders by them, so a thought still lands above the tool call it led to.
//  - The API proxy, for sessions that go through it (not the desktop app, which sets its own
//    ANTHROPIC_BASE_URL): thinking and tool input token by token.
//
// Every item has a stable id so the same thing reported by several sources is one card:
// a tool call is its tool_use id, a thinking or text block is `<message id>:<block index>`.

const path = require('path');
const crypto = require('crypto');

const MAX_ITEMS = 600;
const MAX_INPUT = 16000;
const MAX_OUTPUT = 12000;
const MAX_TEXT = 24000;
const DONE = new Set(['ok', 'error', 'denied', 'interrupted']);

const cap = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '\n…' : s);
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
const tsOf = (v) => {
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? t : Date.now();
};

// ---------------------------------------------------------------------------
// What a tool call is: service, title, the command or query worth showing

const SERVICES = {
  supabase: 'Supabase', vercel: 'Vercel', github: 'GitHub', git: 'Git', npm: 'npm', node: 'Node',
  postgres: 'Postgres', http: 'HTTP', python: 'Python', docker: 'Docker', shell: 'Shell', files: 'Files',
  search: 'Search', edit: 'Edit', web: 'Web', agent: 'Agent', skill: 'Skill', browser: 'Browser',
  chrome: 'Chrome', app: 'Claude app', slack: 'Slack', hubspot: 'HubSpot', gmail: 'Gmail',
  microsoft: 'Microsoft 365', dropbox: 'Dropbox', canva: 'Canva', higgsfield: 'Higgsfield',
  docs: 'Claude Docs', artifact: 'Artifact', anthropic: 'Anthropic', xcode: 'Xcode', brew: 'Homebrew',
  stripe: 'Stripe', aws: 'AWS', gcloud: 'Google Cloud', ios: 'iOS Simulator', tasks: 'Tasks',
  terminal: 'Terminal', claude: 'Claude Code', mcp: 'MCP',
};

const ACRONYMS = { sql: 'SQL', url: 'URL', api: 'API', id: 'ID', ai: 'AI', pr: 'PR', js: 'JS', mcp: 'MCP', crm: 'CRM', aeo: 'AEO', ios: 'iOS', db: 'DB', ts: 'TS' };
function humanize(name) {
  const words = String(name).replace(/([a-z])([A-Z])/g, '$1 $2').split(/[_\-\s]+/).filter(Boolean);
  return words
    .map((w, i) => {
      const lw = w.toLowerCase();
      if (ACRONYMS[lw]) return ACRONYMS[lw];
      return i === 0 ? lw[0].toUpperCase() + lw.slice(1) : lw;
    })
    .join(' ');
}

// Split a shell command into its simple commands, roughly: good enough to find the program
// that matters in `cd x && npx supabase db push | tail`. Quotes are respected; heredoc
// bodies and subshells are not parsed.
function segments(cmd) {
  const out = [];
  let cur = '';
  let q = '';
  for (let i = 0; i < cmd.length && out.length < 24; i++) {
    const c = cmd[i];
    if (q) {
      if (c === q) q = '';
      else if (c === '\\' && q === '"') cur += cmd[i++];
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      cur += c;
      continue;
    }
    if (c === '\n' || c === ';' || c === '|' || (c === '&' && cmd[i + 1] === '&')) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      if (c === '&' || (c === '|' && cmd[i + 1] === '|')) i++;
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function words(seg) {
  const out = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(seg)) && out.length < 12) out.push(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3]);
  return out;
}
const WRAPPERS = new Set(['sudo', 'time', 'env', 'exec', 'nohup', 'command', 'builtin', 'caffeinate', 'timeout']);
function programOf(seg) {
  const w = words(seg);
  while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w.shift();
  while (w.length && WRAPPERS.has(w[0])) {
    w.shift();
    while (w.length && /^-/.test(w[0])) w.shift();
  }
  if (!w.length) return null;
  let via = '';
  if (['npx', 'bunx', 'pnpx'].includes(w[0]) || (['pnpm', 'yarn', 'bun'].includes(w[0]) && ['dlx', 'x'].includes(w[1]))) {
    via = w[0];
    w.splice(0, w[0] === 'npx' || w[0] === 'bunx' || w[0] === 'pnpx' ? 1 : 2);
    while (w.length && /^-/.test(w[0])) w.shift();
  }
  if (!w.length) return null;
  const prog = path.basename(w[0].replace(/@[^/]*$/, '')).toLowerCase();
  return { prog, args: w.slice(1), via };
}

// Higher wins when a command chains several programs.
const PROGRAMS = {
  supabase: [9, 'supabase', 'Supabase CLI'], vercel: [9, 'vercel', 'Vercel CLI'], gh: [9, 'github', 'GitHub CLI'],
  psql: [9, 'postgres', 'psql'], pg_dump: [9, 'postgres', 'pg_dump'], stripe: [9, 'stripe', 'Stripe CLI'],
  aws: [9, 'aws', 'AWS CLI'], gcloud: [9, 'gcloud', 'gcloud'], firebase: [8, 'gcloud', 'Firebase CLI'],
  docker: [8, 'docker', 'docker'], xcodebuild: [8, 'xcode', 'xcodebuild'], xcrun: [8, 'xcode', 'xcrun'],
  claude: [8, 'claude', 'claude'], git: [7, 'git', 'git'], curl: [6, 'http', 'curl'], wget: [6, 'http', 'wget'],
  npm: [5, 'npm', 'npm'], pnpm: [5, 'npm', 'pnpm'], yarn: [5, 'npm', 'yarn'], bun: [5, 'npm', 'bun'],
  next: [5, 'npm', 'next'], eslint: [5, 'npm', 'eslint'], tsc: [5, 'npm', 'tsc'], prettier: [5, 'npm', 'prettier'],
  node: [4, 'node', 'node'], python: [4, 'python', 'python'], python3: [4, 'python', 'python3'], pip: [4, 'python', 'pip'],
  brew: [4, 'brew', 'brew'],
};
const HOSTS = [
  [/(^|\.)supabase\.(co|com|in)$/, 'supabase', 'Supabase API'],
  [/(^|\.)vercel\.(com|app)$/, 'vercel', 'Vercel API'],
  [/(^|\.)github\.com$|(^|\.)githubusercontent\.com$/, 'github', 'GitHub API'],
  [/(^|\.)anthropic\.com$|(^|\.)claude\.ai$/, 'anthropic', 'Anthropic API'],
  [/(^|\.)hubapi\.com$|(^|\.)hubspot\.com$/, 'hubspot', 'HubSpot API'],
  [/(^|\.)slack\.com$/, 'slack', 'Slack API'],
];

function classifyBash(input) {
  const cmd = typeof input.command === 'string' ? input.command : '';
  let best = null;
  for (const seg of segments(cmd)) {
    const p = programOf(seg);
    if (!p) continue;
    const known = PROGRAMS[p.prog];
    const rank = known ? known[0] : 1;
    if (!best || rank > best.rank) best = { ...p, rank, known };
  }
  const meta = { svc: 'shell', title: 'Shell', detail: cap(cmd, MAX_INPUT), lang: 'bash', sub: input.description || '' };
  if (input.run_in_background) meta.sub = (meta.sub ? meta.sub + ' · ' : '') + 'in background';
  if (!best) return meta;
  const sub = best.args.filter((a) => !/^-/.test(a)).slice(0, 2).join(' ');
  if (!best.known) {
    meta.title = best.prog;
    return meta;
  }
  meta.svc = best.known[1];
  meta.title = best.known[2];
  if (best.prog === 'curl' || best.prog === 'wget') {
    const url = best.args.find((a) => /^https?:\/\//.test(a));
    if (url) {
      let host = '';
      try { host = new URL(url).host; } catch {}
      const h = HOSTS.find(([re]) => re.test(host.replace(/:\d+$/, '')));
      if (h) {
        meta.svc = h[1];
        meta.title = h[2];
      } else meta.title = `${best.prog} ${host}`;
    }
  } else if (['supabase', 'vercel', 'gh', 'git', 'npm', 'pnpm', 'yarn', 'bun', 'docker', 'stripe', 'aws', 'gcloud', 'firebase', 'brew', 'next'].includes(best.prog)) {
    if (sub) meta.title += ' ' + sub;
  } else if (best.via) meta.title = `${best.via} ${best.prog}`;
  return meta;
}

// MCP servers are often registered under an opaque id, so the service is recognized from its
// tool names and remembered per server once known.
const MCP_SERVERS = [
  [/browser/i, 'browser'], [/chrome/i, 'chrome'], [/^ccd_/, 'app'], [/^terminal$/, 'terminal'],
  [/ios_simulator/i, 'ios'], [/^scheduled-tasks$/, 'tasks'], [/^visualize$/, 'artifact'],
  [/supabase/i, 'supabase'], [/vercel/i, 'vercel'], [/github/i, 'github'], [/slack/i, 'slack'],
  [/hubspot/i, 'hubspot'], [/gmail/i, 'gmail'], [/canva/i, 'canva'], [/dropbox/i, 'dropbox'],
];
const MCP_TOOLS = [
  [/^(execute_sql|apply_migration|list_tables|list_migrations|list_extensions|get_advisors|query_logs|get_logs|deploy_edge_function|get_edge_function|list_edge_functions|generate_typescript_types|get_publishable_keys|get_project_url|list_branches|create_branch|merge_branch|rebase_branch|reset_branch|delete_branch|confirm_cost|get_cost|pause_project|restore_project)$/, 'supabase'],
  [/deployment|^get_project_domain|^list_teams$|vercel/, 'vercel'],
  [/^slack_/, 'slack'],
  [/^(outlook_|teams_|sharepoint_)|^(find_meeting_availability|search_people|chat_message_search|get_granted_scopes|get_me)$/, 'microsoft'],
  [/^(search_threads|get_thread|create_draft|update_draft|delete_draft|list_drafts|get_draft|list_labels|create_label|label_thread|label_message|unlabel_|trash_thread|trash_message|untrash_|forward|reply|mark_(thread|message)_spam|apply_sensitive_)/, 'gmail'],
  [/crm|hubspot|_aeo_|^manage_(blog_post|landing_page|marketing_email|segment|website_page|saved_reports|onboarding|campaign_objects)$|^search_owners$|^get_campaign_|^read_campaign_data$/, 'hubspot'],
  [/^(who_am_i|get_file_content|list_folder|create_shared_link|list_file_revisions|get_usage_and_quota|download_link|get_markdown|get_transcript|list_shared_links|restore_file_revision|list_restore_events|restore_folder|create_file_request)$/, 'dropbox'],
  [/-design|brand-template|brand-kit|^get-assets$|shortlink|-comment|separate-image|^upload-asset|^create-upload-url$/, 'canva'],
  [/^(generate_(image|video|audio|3d)|.*_batch$|upscale_|motion_control|show_generation|reframe|outpaint_image|voice_change|dubbing|tiktok_|shorts_studio|scene_builder_3d|virality_predictor|media_upload|models_explore|get_presets|execute_preset|website_|create_website|deploy_website)/, 'higgsfield'],
];
const servers = new Map();

function mcpService(server, tool, input) {
  if (servers.has(server)) return servers.get(server);
  let svc = null;
  for (const [re, s] of MCP_SERVERS) if (re.test(server)) { svc = s; break; }
  if (!svc) for (const [re, s] of MCP_TOOLS) if (re.test(tool)) { svc = s; break; }
  if (!svc && input && typeof input === 'object' && input.container) svc = 'docs';
  if (!svc && input && typeof input.project_id === 'string' && /^[a-z]{20}$/.test(input.project_id)) svc = 'supabase';
  if (svc) servers.set(server, svc);
  return svc || 'mcp';
}

const PICK = ['query', 'sql', 'command', 'url', 'text', 'prompt', 'pattern', 'path', 'file_path', 'message', 'name', 'intent', 'description'];
function detailOf(input) {
  if (!input || typeof input !== 'object') return { detail: '', lang: null };
  const keys = Object.keys(input);
  if (!keys.length) return { detail: '', lang: null };
  const str = keys.filter((k) => typeof input[k] === 'string');
  if (keys.length === 1 && str.length === 1) return { detail: cap(input[keys[0]], MAX_INPUT), lang: null };
  let json;
  try { json = JSON.stringify(input, null, 2); } catch { json = ''; }
  return { detail: cap(json, MAX_INPUT), lang: 'json' };
}

function classifyMcp(name, input) {
  const m = name.match(/^mcp__(.+?)__(.+)$/);
  if (!m) return null;
  const [, server, tool] = m;
  const svc = mcpService(server, tool, input);
  const label = SERVICES[svc] || humanize(server);
  const meta = { svc, title: `${label} · ${humanize(tool)}`, sub: '', ...detailOf(input) };
  if (svc === 'supabase' && typeof input.query === 'string') {
    meta.detail = cap(input.query, MAX_INPUT);
    meta.lang = 'sql';
    if (tool === 'apply_migration' && input.name) meta.sub = input.name;
  } else if (svc === 'browser' || svc === 'chrome') {
    const a = input.action || '';
    if (tool === 'navigate' || tool === 'open_url') meta.sub = input.url || '';
    else if (tool === 'computer') meta.sub = [a, input.text, input.coordinate && input.coordinate.join(','), input.ref].filter(Boolean).join(' · ');
    else if (tool === 'find') meta.sub = input.query || '';
    else if (tool === 'preview_start') meta.sub = input.name || input.url || '';
    else if (tool === 'browser_batch' && Array.isArray(input.actions)) meta.sub = input.actions.map((x) => (x.input && x.input.action) || x.name).join(' → ');
    if (tool === 'javascript_tool' || tool === 'execute_javascript') {
      meta.detail = cap(input.text || input.code || '', MAX_INPUT);
      meta.lang = 'javascript';
    } else if (tool !== 'browser_batch') {
      meta.detail = '';
      meta.lang = null;
    }
  } else if (svc === 'slack' && input.channel_id) {
    meta.sub = input.channel_id;
  }
  return meta;
}

const rel = (file, cwd) => {
  if (!file) return '';
  if (cwd && file.startsWith(cwd + path.sep)) return file.slice(cwd.length + 1);
  const home = process.env.HOME || '';
  return home && file.startsWith(home + path.sep) ? '~' + file.slice(home.length) : file;
};

function classify(name, input, cwd) {
  const meta = classifyTool(String(name || ''), input && typeof input === 'object' ? input : {}, cwd);
  meta.label = SERVICES[meta.svc] || meta.svc;
  return meta;
}

function classifyTool(name, input, cwd) {
  if (name === 'Bash') return classifyBash(input);
  if (name.startsWith('mcp__')) return classifyMcp(name, input) || { svc: 'mcp', title: humanize(name), ...detailOf(input) };
  const file = input.file_path || input.notebook_path || '';
  switch (name) {
    case 'Read': {
      const range = input.offset || input.limit ? ` · lines ${input.offset || 1}${input.limit ? '–' + ((input.offset || 1) + input.limit - 1) : '+'}` : '';
      return { svc: 'files', title: 'Read ' + path.basename(file), sub: rel(file, cwd) + range, file };
    }
    case 'Write':
      return { svc: 'edit', title: 'Write ' + path.basename(file), sub: rel(file, cwd), file };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { svc: 'edit', title: 'Edit ' + path.basename(file), sub: rel(file, cwd), file };
    case 'Grep':
      return { svc: 'search', title: `Search “${cap(input.pattern || '', 80)}”`, sub: [rel(input.path, cwd), input.glob, input.type].filter(Boolean).join(' · ') };
    case 'Glob':
      return { svc: 'search', title: `Find ${cap(input.pattern || '', 80)}`, sub: rel(input.path, cwd) };
    case 'WebFetch': {
      let host = input.url || '';
      try { host = new URL(input.url).host; } catch {}
      return { svc: 'web', title: 'Fetch ' + host, sub: input.url || '', detail: cap(input.prompt || '', MAX_INPUT) };
    }
    case 'WebSearch':
      return { svc: 'web', title: `Search the web “${cap(input.query || '', 100)}”` };
    case 'Agent':
    case 'Task':
      return { svc: 'agent', title: 'Subagent: ' + (input.description || 'task'), sub: input.subagent_type || '', detail: cap(input.prompt || '', MAX_INPUT) };
    case 'Skill':
      return { svc: 'skill', title: 'Skill ' + (input.skill || ''), sub: input.args || '' };
    case 'ToolSearch':
      return { svc: 'claude', title: 'Load tools', sub: input.query || '' };
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return { svc: 'tasks', title: humanize(name), ...detailOf(input) };
    case 'Artifact':
      return { svc: 'artifact', title: 'Artifact · ' + (input.action || 'publish'), sub: input.file_path || input.url || '' };
    case 'AskUserQuestion':
      return { svc: 'claude', title: 'Asking you a question', ...detailOf(input) };
    default:
      return { svc: 'claude', title: humanize(name), ...detailOf(input) };
  }
}

// ---------------------------------------------------------------------------
// Tool results: text worth showing, and a table when a query returned rows

function outputText(resp, name) {
  if (resp == null) return '';
  if (typeof resp === 'string') return resp;
  if (Array.isArray(resp)) {
    return resp
      .map((b) => (typeof b === 'string' ? b : b && b.type === 'text' ? b.text : b && b.type === 'image' ? '[image]' : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof resp === 'object') {
    if ('stdout' in resp || 'stderr' in resp) {
      const out = [resp.stdout, resp.stderr].filter(Boolean).join('\n');
      return out + (resp.interrupted ? '\n[interrupted]' : '') + (resp.backgroundTaskId ? `[running in background: ${resp.backgroundTaskId}]` : '');
    }
    if (name === 'Read' || (resp.type === 'text' && resp.file)) {
      const f = resp.file || {};
      return f.numLines ? `${f.numLines} lines` : '';
    }
    if (name === 'Edit' || name === 'Write' || name === 'MultiEdit') return '';
    if (resp.content != null) return outputText(resp.content, name);
    if (Array.isArray(resp.filenames)) return resp.filenames.slice(0, 50).join('\n') + (resp.numFiles > 50 ? `\n… ${resp.numFiles} files` : '');
    try { return JSON.stringify(resp, null, 2); } catch { return ''; }
  }
  return String(resp);
}

function cell(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    try { v = JSON.stringify(v); } catch { v = String(v); }
  }
  return cap(String(v), 120);
}

// Supabase's execute_sql answers with {"result": "...<untrusted-data>[rows]</untrusted-data>..."}.
function tableFrom(text) {
  if (!text || text.length > 400000) return null;
  let s = text;
  try {
    const j = JSON.parse(text);
    if (j && typeof j.result === 'string') s = j.result;
    else if (Array.isArray(j)) s = text;
  } catch {}
  const a = s.indexOf('[');
  const b = s.lastIndexOf(']');
  if (a < 0 || b <= a) return null;
  let rows;
  try { rows = JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  if (!Array.isArray(rows) || !rows.every((r) => r && typeof r === 'object' && !Array.isArray(r))) return null;
  const cols = [];
  for (const r of rows.slice(0, 20)) for (const k of Object.keys(r)) if (!cols.includes(k) && cols.length < 8) cols.push(k);
  return { cols, rows: rows.slice(0, 8).map((r) => cols.map((c) => cell(r[c]))), total: rows.length };
}

function summarizeOutput(text, meta) {
  const out = { text: cap(text || '', MAX_OUTPUT) };
  if (meta && (meta.lang === 'sql' || meta.svc === 'supabase')) {
    const t = tableFrom(text);
    if (t) out.table = t;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Prompts: what the person typed, not the scaffolding around it

function promptText(content) {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    if (content.some((b) => b && b.type === 'tool_result')) return '';
    text = content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
  }
  text = text.trim();
  if (!text || /^<(command-|local-command|system-reminder|task-notification|bash-|user-memory)/.test(text) || text.startsWith('Caveat:')) return '';
  return text;
}
const promptId = (session, text) => `prompt:${session}:${hash(text.replace(/\s+/g, ' ').slice(0, 600))}`;

// ---------------------------------------------------------------------------
// The store

class Activity {
  constructor({ broadcast, log }) {
    this.broadcast = broadcast;
    this.log = log || (() => {});
    this.items = new Map();
    this.sessions = new Map();
    this.pendingDelta = new Map();
    this.pendingFull = new Set();
    this.deltaTimer = null;
  }

  session(id, patch) {
    if (!id) return null;
    let s = this.sessions.get(id);
    if (!s) {
      s = { id, project: '', cwd: '', agent: '', state: 'idle', since: Date.now(), tool: null, hooks: false, entry: '', lastInput: 0, running: new Set(), at: Date.now() };
      this.sessions.set(id, s);
    }
    if (patch) {
      for (const [k, v] of Object.entries(patch)) if (v != null && v !== '') s[k] = v;
      if (patch.cwd && !s.project) s.project = path.basename(patch.cwd);
    }
    s.at = Date.now();
    return s;
  }

  setState(s, state, since, tool, force) {
    if (!s) return;
    if (!force && s.state === state && s.tool === (tool || null) && state !== 'thinking') return;
    if (!force && s.state === state && state === 'thinking' && Math.abs(s.since - since) < 50) return;
    s.state = state;
    s.since = since || Date.now();
    s.tool = tool || null;
    this.broadcast('act-state', this.stateOf(s));
  }
  stateOf(s) {
    return { session: s.id, project: s.project, state: s.state, since: s.since, tool: s.tool, precise: s.hooks, entry: s.entry };
  }

  upsert(raw, opts) {
    const prev = this.items.get(raw.id);
    const it = prev ? { ...prev } : { id: raw.id };
    for (const [k, v] of Object.entries(raw)) {
      if (v === undefined) continue;
      if (k === 'ts') it.ts = prev && prev.ts ? Math.min(prev.ts, v) : v;
      else if (k === 'status') {
        if (!(prev && DONE.has(prev.status) && !DONE.has(v))) it.status = v;
      } else if (k === 'text') {
        if (raw.final || !prev || !prev.text || (typeof v === 'string' && v.length >= (prev.text || '').length)) it.text = cap(v, MAX_TEXT);
      } else if (k === 'meta' || k === 'input') {
        if (!prev || !prev[k] || !raw.partial) it[k] = v;
      } else if (k === 'ended') it.ended = Math.max(prev && prev.ended ? prev.ended : 0, v);
      else if (k !== 'final' && k !== 'partial') it[k] = v;
    }
    // Proxy input streams in as partial; a hook or the transcript then reports the final form.
    if (raw.partial !== undefined && !(raw.partial && prev && prev.partial === false)) it.partial = !!raw.partial;
    if (!it.ts) it.ts = Date.now();
    if (prev && JSON.stringify(prev) === JSON.stringify(it)) return it;
    this.items.delete(it.id);
    this.items.set(it.id, it);
    if (this.items.size > MAX_ITEMS) this.items.delete(this.items.keys().next().value);
    if (!(opts && opts.quiet)) this.broadcast('act', it);
    return it;
  }

  // Streaming from the proxy, throttled. Thinking and reply text go out as appended deltas; a
  // tool input field re-classifies the call and resends the card, so a Bash command or a SQL
  // query is shown as it is being written.
  delta(id, field, text) {
    const it = this.items.get(id);
    if (!it || !text || !it.partial) return;
    if (field === 'text') {
      it.text = cap((it.text || '') + text, MAX_TEXT);
      this.pendingDelta.set(id, (this.pendingDelta.get(id) || '') + text);
    } else {
      it.input = { ...(it.input || {}), [field]: ((it.input && it.input[field]) || '') + text };
      it.meta = classify(it.name, it.input);
      this.pendingFull.add(id);
    }
    if (this.deltaTimer) return;
    this.deltaTimer = setTimeout(() => {
      this.deltaTimer = null;
      for (const [iid, t] of this.pendingDelta) this.broadcast('act-delta', { id: iid, text: t });
      this.pendingDelta.clear();
      for (const iid of this.pendingFull) if (this.items.has(iid)) this.broadcast('act', this.items.get(iid));
      this.pendingFull.clear();
    }, 40);
  }

  snapshot() {
    const items = [...this.items.values()].slice(-300);
    const cutoff = Date.now() - 30 * 60e3;
    const sessions = [...this.sessions.values()].filter((s) => s.at > cutoff).map((s) => this.stateOf(s));
    return { items, sessions };
  }

  // ------------------------------------------------------------------------
  // Hooks

  fromHook(p, entry) {
    const event = p.hook_event_name;
    const s = this.session(p.session_id, { cwd: p.cwd, entry });
    if (!s) return;
    const now = Date.now();
    const agent = p.agent_id || p.agent_type || '';
    if (event === 'UserPromptSubmit') {
      const text = typeof p.prompt === 'string' ? promptText(p.prompt) : '';
      if (text) this.upsert({ id: promptId(s.id, text), kind: 'prompt', session: s.id, project: s.project, ts: now, text });
      s.lastInput = now;
      s.running.clear();
      this.setState(s, 'thinking', now);
      return;
    }
    if (event === 'Stop') {
      s.running.clear();
      this.setState(s, 'idle', now);
      return;
    }
    if (event === 'SessionStart') {
      this.setState(s, 'idle', now);
      return;
    }
    if (!p.tool_name || !p.tool_use_id) return;
    // A hook for a tool other than Write/Edit means this session has the all-tools hooks, so
    // its state (thinking vs. running a tool) is known exactly rather than inferred.
    if (!/^(Write|Edit|MultiEdit)$/.test(p.tool_name)) s.hooks = true;
    const id = p.tool_use_id;
    if (event === 'PreToolUse') {
      const meta = classify(p.tool_name, p.tool_input, p.cwd);
      this.upsert({ id, kind: 'tool', session: s.id, project: s.project, agent, name: p.tool_name, input: trimInput(p.tool_input), meta, status: 'running', ts: now, started: now, partial: false });
      s.running.add(id);
      if (s.hooks) this.setState(s, 'tool', now, id);
    } else if (event === 'PostToolUse' || event === 'PostToolUseFailure' || event === 'PermissionDenied') {
      const prev = this.items.get(id);
      const meta = (prev && prev.meta) || classify(p.tool_name, p.tool_input, p.cwd);
      const failed = event !== 'PostToolUse';
      const text = failed ? outputText(p.error || p.tool_response || '', p.tool_name) : outputText(p.tool_response, p.tool_name);
      const status = event === 'PermissionDenied' ? 'denied' : failed ? (p.is_interrupt ? 'interrupted' : 'error') : 'ok';
      this.upsert({
        id, kind: 'tool', session: s.id, project: s.project, agent, name: p.tool_name,
        input: prev && prev.input ? undefined : trimInput(p.tool_input), meta, status,
        ts: prev ? undefined : now, ended: now, output: summarizeOutput(text, meta), partial: false,
      });
      s.running.delete(id);
      s.lastInput = now;
      if (s.hooks && !s.running.size) this.setState(s, 'thinking', now);
    }
  }

  // Edit stats from the file snapshots, attached to the edit's tool card.
  editDone(toolUseId, edit) {
    if (!toolUseId || !this.items.has(toolUseId)) return;
    this.upsert({ id: toolUseId, edit: { id: edit.id, file: edit.file, adds: edit.adds, dels: edit.dels, created: edit.created } });
  }

  // ------------------------------------------------------------------------
  // Transcripts

  fromTranscript(j, ctx) {
    const sessionId = j.sessionId || ctx.session;
    if (!sessionId) return;
    const s = this.session(sessionId, { cwd: j.cwd, entry: j.entrypoint });
    const ts = tsOf(j.timestamp);
    const agent = ctx.agent || '';
    const quiet = !!ctx.backlog;
    const base = { session: s.id, project: s.project, agent, backlog: ctx.backlog || undefined };
    const m = j.message;

    if (j.type === 'assistant' && m && Array.isArray(m.content)) {
      const counts = ctx.blocks || (ctx.blocks = new Map());
      for (const b of m.content) {
        const n = j.apiBlockIndex != null ? Number(j.apiBlockIndex) : counts.get(m.id) || 0;
        counts.set(m.id, n + 1);
        if (counts.size > 200) counts.delete(counts.keys().next().value);
        const bid = `${m.id}:${n}`;
        // How long a thought took: from the previous thing in this session (the input that
        // started this model call, or the block before it). Blocks stamped within a second of
        // each other came out together, so no duration is claimed for the later one.
        const since = ctx.prevTs || ctx.lastInput || s.lastInput || 0;
        ctx.prevTs = ts;
        if (b.type === 'thinking' || b.type === 'redacted_thinking') {
          this.upsert({ ...base, id: bid, kind: 'think', ts, text: b.thinking || '', ms: since && ts - since >= 1000 ? ts - since : undefined, final: true, partial: false }, { quiet });
        } else if (b.type === 'text' && b.text && b.text.trim()) {
          this.upsert({ ...base, id: bid, kind: 'text', ts, text: b.text, final: true, partial: false }, { quiet });
        } else if (b.type === 'tool_use') {
          const prev = this.items.get(b.id);
          this.upsert({
            ...base, id: b.id, kind: 'tool', ts, name: b.name, input: trimInput(b.input),
            meta: prev && prev.meta && !prev.partial ? undefined : classify(b.name, b.input, j.cwd),
            status: prev ? undefined : ctx.backlog ? 'ok' : 'running', partial: false,
          }, { quiet });
          (ctx.pending || (ctx.pending = new Set())).add(b.id);
        }
      }
      if (m.stop_reason === 'end_turn' && !ctx.backlog) this.inferred(s, 'idle', ts);
      else if (!ctx.backlog) this.inferred(s, 'working', ts);
      return;
    }

    if (j.type === 'user' && m) {
      if (Array.isArray(m.content) && m.content.some((b) => b && b.type === 'tool_result')) {
        for (const b of m.content) {
          if (!b || b.type !== 'tool_result') continue;
          const prev = this.items.get(b.tool_use_id);
          // A result whose call was never seen (it sat just before where the backlog read
          // started) has nothing to attach to.
          if (!prev) continue;
          const name = prev.name;
          const text = outputText(j.toolUseResult != null && m.content.length === 1 ? j.toolUseResult : b.content, name);
          const interrupted = typeof b.content === 'string' && /interrupted by user/i.test(b.content);
          this.upsert({
            ...base, id: b.tool_use_id, kind: 'tool', ended: ts,
            status: b.is_error ? (interrupted ? 'interrupted' : 'error') : 'ok',
            output: prev && prev.output && prev.output.text ? undefined : summarizeOutput(text, prev && prev.meta),
          }, { quiet });
          if (ctx.pending) ctx.pending.delete(b.tool_use_id);
        }
        ctx.lastInput = ctx.prevTs = ts;
        if (!ctx.backlog && !(ctx.pending && ctx.pending.size)) this.inferred(s, 'working', ts);
        return;
      }
      if (j.isMeta || j.isSidechain && !agent) return;
      const text = promptText(m.content);
      if (!text) return;
      if (/^\[Request interrupted/.test(text)) {
        this.upsert({ ...base, id: 'note:' + (j.uuid || ts), kind: 'note', ts, text: 'Interrupted' }, { quiet });
        if (!ctx.backlog) this.inferred(s, 'idle', ts);
        return;
      }
      ctx.lastInput = ctx.prevTs = ts;
      if (!agent) this.upsert({ ...base, id: promptId(s.id, text), kind: 'prompt', ts, text }, { quiet });
      // A new prompt starts a new turn, so the "Working" clock starts over.
      if (!ctx.backlog) this.inferred(s, 'working', ts, true);
      return;
    }

    if (j.type === 'attachment' && j.attachment && j.attachment.type === 'queued_command') {
      const text = promptText(j.attachment.prompt);
      if (text) this.upsert({ ...base, id: promptId(s.id, text), kind: 'prompt', ts, text, queued: true }, { quiet });
      return;
    }

    if (j.type === 'system' && j.subtype === 'stop_hook_summary' && !ctx.backlog) this.inferred(s, 'idle', ts);
  }

  // State read from the transcript. With the all-tools hooks installed the hooks know better
  // (and sooner), so this only applies to sessions without them.
  inferred(s, state, ts, force) {
    if (s.hooks) return;
    if (state === 'working' && Date.now() - ts > 20 * 60e3) state = 'idle';
    this.setState(s, state, ts, null, force);
  }
}

function trimInput(input) {
  if (!input || typeof input !== 'object') return input;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') out[k] = cap(v, k === 'content' || k === 'new_string' || k === 'old_string' ? 2000 : MAX_INPUT);
    else out[k] = v;
  }
  let size = 0;
  try { size = JSON.stringify(out).length; } catch {}
  return size > MAX_INPUT * 2 ? { _truncated: true } : out;
}

module.exports = { Activity, classify, SERVICES, humanize };
