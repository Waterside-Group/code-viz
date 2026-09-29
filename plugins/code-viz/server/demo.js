'use strict';
// A scripted session that exercises every animation, plus made-up team authorship:
//  1. a live Edit of an existing file written by two (fictional) teammates,
//  2. a hook-only Edit (the replay path used when live streaming is off),
//  3. a live Write of a brand-new file.

const { splitLines, diffLines, EQ } = require('./viewer/diff');
const { CLAUDE } = require('./blame');

const PROJECT = '/demo/weather-app';
const FILE = PROJECT + '/src/forecast.ts';
const TEST_FILE = PROJECT + '/src/forecast.test.ts';

const V1 = `import { fetchJson } from './http';

export interface Forecast {
  city: string;
  highC: number;
  lowC: number;
  summary: string;
}

const API = 'https://api.example.com/v1/forecast';

export async function getForecast(city: string): Promise<Forecast> {
  const data = await fetchJson(\`\${API}?city=\${encodeURIComponent(city)}\`);
  return {
    city,
    highC: data.high,
    lowC: data.low,
    summary: data.summary ?? 'No summary available',
  };
}

export function formatForecast(f: Forecast): string {
  return \`\${f.city}: \${f.summary}, \${f.lowC}° to \${f.highC}°C\`;
}
`;

const EDIT1 = {
  old_string: `export async function getForecast(city: string): Promise<Forecast> {
  const data = await fetchJson(\`\${API}?city=\${encodeURIComponent(city)}\`);`,
  new_string: `const cache = new Map<string, { at: number; value: Forecast }>();
const TTL_MS = 10 * 60 * 1000;

export async function getForecast(city: string): Promise<Forecast> {
  const hit = cache.get(city);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const data = await fetchJson(\`\${API}?city=\${encodeURIComponent(city)}\`);`,
};

const EDIT2 = [
  [
    `  return {
    city,
    highC: data.high,
    lowC: data.low,
    summary: data.summary ?? 'No summary available',
  };
}`,
    `  const value: Forecast = {
    city,
    highC: data.high,
    lowC: data.low,
    summary: data.summary ?? 'No summary available',
  };
  cache.set(city, { at: Date.now(), value });
  return value;
}`,
  ],
  [
    `export function formatForecast(f: Forecast): string {
  return \`\${f.city}: \${f.summary}, \${f.lowC}° to \${f.highC}°C\`;
}`,
    `export function formatForecast(f: Forecast, unit: 'C' | 'F' = 'C'): string {
  const t = (c: number) => Math.round(unit === 'F' ? c * 1.8 + 32 : c);
  return \`\${f.city}: \${f.summary}, \${t(f.lowC)}° to \${t(f.highC)}°\${unit}\`;
}`,
  ],
];

const TEST = `import { describe, expect, it, vi } from 'vitest';
import { formatForecast, getForecast } from './forecast';
import * as http from './http';

describe('getForecast', () => {
  it('caches results for ten minutes', async () => {
    const spy = vi.spyOn(http, 'fetchJson').mockResolvedValue({ high: 21, low: 12, summary: 'Sunny' });
    await getForecast('Oslo');
    await getForecast('Oslo');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('formatForecast', () => {
  it('converts to Fahrenheit', () => {
    const f = { city: 'Oslo', highC: 20, lowC: 10, summary: 'Clear' };
    expect(formatForecast(f, 'F')).toBe('Oslo: Clear, 50° to 68°F');
  });
});
`;

// Fictional history for V1: who last touched each line.
const DAY = 24 * 60 * 60 * 1000;
const PEOPLE = [
  { key: 'gh:priya-shah', name: 'Priya Shah', login: 'priya-shah' },
  { key: 'gh:marcuslee', name: 'Marcus Lee', login: 'marcuslee' },
  CLAUDE,
];
const COMMITS = [
  { sha: 'a3f1c9e27b0d4c8e9f1a2b3c4d5e6f708192a3b4', summary: 'Add Forecast type and API endpoint', days: 12, person: 0, pr: 41, prTitle: 'Forecast types' },
  { sha: 'b7d24e1f0a9c8b7d6e5f4a3b2c1d0e9f8a7b6c5d', summary: 'Fetch forecasts from the weather API', days: 4, person: 1, pr: 57, prTitle: 'Weather API client', claude: true },
  { sha: 'c90e5a2d1b3c4e5f6a7b8c9d0e1f2a3b4c5d6e7f', summary: 'Format forecast for the widget', days: 2, person: 0, pr: 63, prTitle: 'Forecast widget' },
];
// Line ranges of V1 (0-based, inclusive) and the commit that last changed them.
const V1_OWNERS = [[0, 1, 1], [2, 10, 0], [11, 20, 1], [21, 23, 2]];

function owns(file) {
  return file.startsWith(PROJECT + '/');
}

function blame(file, text) {
  const now = Date.now();
  const lines = splitLines(text || '');
  const commits = COMMITS.map((c) => ({
    sha: c.sha,
    summary: c.summary,
    time: now - c.days * DAY,
    author: PEOPLE[c.person].name,
    person: c.person,
    claude: !!c.claude,
    coauthors: c.claude ? ['Claude'] : [],
    url: null,
    pr: { number: c.pr, title: c.prTitle, url: null },
  }));
  const v1Commit = [];
  for (const [a, b, ci] of V1_OWNERS) for (let i = a; i <= b; i++) v1Commit[i] = ci;
  const out = lines.map(() => [2, -1]);
  if (file === FILE) {
    for (const o of diffLines(splitLines(V1), lines)) {
      if (o.t === EQ) out[o.b] = [COMMITS[v1Commit[o.a]].person, v1Commit[o.a]];
    }
  }
  return {
    file,
    text,
    demo: true,
    repo: { top: PROJECT, name: 'weather-app', github: 'example/weather-app', ghLogin: null, ghOk: true },
    people: PEOPLE,
    commits,
    lines: out,
  };
}

// Stream a tool input the way the API does: small, uneven chunks of JSON. Pauses briefly once
// the file path is complete, so the file (and who wrote it) is visible before the edit starts.
async function streamInput(api, id, tool, input, base, pause) {
  const stream = api.stream(id, tool, base);
  const json = JSON.stringify(input);
  const pathEnd = json.indexOf('"', json.indexOf('"file_path":"') + 13) + 1;
  let paused = !pause;
  for (let i = 0; i < json.length; ) {
    const n = 2 + Math.floor(Math.random() * 9);
    const end = !paused && i < pathEnd && i + n >= pathEnd ? pathEnd : i + n;
    stream.feed(json.slice(i, end));
    i = end;
    if (!paused && i >= pathEnd) {
      paused = true;
      await api.sleep(pause);
    }
    await api.sleep(16 + Math.random() * 26);
  }
  stream.end(false);
}

async function runDemo(api) {
  api.project(PROJECT);

  // 1. Live Edit of the team's file: add a cache in front of the fetch.
  let id = api.id();
  await streamInput(api, id, 'Edit', { file_path: FILE, ...EDIT1, replace_all: false }, V1, 1800);
  const v2 = V1.replace(EDIT1.old_string, EDIT1.new_string);
  await api.sleep(450);
  api.pre(id, 'Edit', FILE, V1);
  await api.sleep(120);
  api.post(id, 'Edit', FILE, V1, v2);
  await api.sleep(2200);

  // 2. Hook-only edit (no live stream): shown as a replay of the saved change.
  id = api.id();
  let v3 = v2;
  for (const [a, b] of EDIT2) v3 = v3.replace(a, b);
  api.pre(id, 'Edit', FILE, v2);
  await api.sleep(300);
  api.post(id, 'Edit', FILE, v2, v3);
  await api.sleep(5500);

  // 3. Live Write of a new test file.
  id = api.id();
  await streamInput(api, id, 'Write', { file_path: TEST_FILE, content: TEST }, null, 0);
  await api.sleep(450);
  api.pre(id, 'Write', TEST_FILE, null);
  await api.sleep(120);
  api.post(id, 'Write', TEST_FILE, null, TEST);
}

module.exports = runDemo;
module.exports.owns = owns;
module.exports.blame = blame;
