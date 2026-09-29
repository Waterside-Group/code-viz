'use strict';
// Code Viz settings: where they live and what they are.
//
// Each setting comes from an environment variable when one is set, else from the config file
// (~/.claude/code-viz/config.json, or $CODE_VIZ_HOME/config.json), else from DEFAULTS.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.CODE_VIZ_HOME || path.join(os.homedir(), '.claude', 'code-viz');
const FILE = path.join(HOME, 'config.json');

const DEFAULTS = {
  port: 4455,
  autoOpen: true,
  theme: 'auto',
  speed: 1,
  follow: true,
  wrap: true,
  authors: true,
  github: true,
  usage: true,
  usagePeriod: 'today',
  sessionTokenBudget: null,
  burnWindowMinutes: 20,
  terminalScreen: true,
  browserScreen: true,
  terminalColor: 'orange',
  screenLines: 200,
  checkForUpdates: true,
  updateCheckIntervalHours: 6,
  updateOn: 'commit',
};
const UPDATE_ON = new Set(['commit', 'version']);
const COLORS = new Set(['orange', 'green', 'amber']);
const THEMES = new Set(['auto', 'light', 'dark']);
const PERIODS = new Set(['today', 'window']);
const SPEEDS = new Set([0.5, 1, 2, 4]);

// The config file as written, or {} when it is missing or empty. Invalid JSON throws.
function readFile() {
  let raw;
  try { raw = fs.readFileSync(FILE, 'utf8'); } catch { return {}; }
  if (!raw.trim()) return {};
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${FILE} must contain a JSON object`);
  return value;
}

function bool(v) {
  if (typeof v === 'boolean') return v;
  const s = String(v == null ? '' : v).toLowerCase();
  if (s === '0' || s === 'false' || s === 'off' || s === 'no') return false;
  if (s === '1' || s === 'true' || s === 'on' || s === 'yes') return true;
  return undefined;
}
function toPort(v) {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined;
}
const pick = (...vals) => vals.find((v) => v !== undefined);

// Effective settings. Never throws: a broken config file falls back to the defaults, and the
// problem is reported in `error`.
function load() {
  let file = {};
  let error = null;
  try { file = readFile(); } catch (e) { error = e.message; }
  const env = process.env;
  const theme = String(pick(env.CODE_VIZ_THEME || undefined, file.theme, DEFAULTS.theme)).toLowerCase();
  const speed = Number(pick(file.speed, DEFAULTS.speed));
  return {
    port: pick(toPort(env.CODE_VIZ_PORT), toPort(file.port), DEFAULTS.port),
    autoOpen: pick(bool(env.CODE_VIZ_AUTO_OPEN), bool(file.autoOpen), DEFAULTS.autoOpen),
    theme: THEMES.has(theme) ? theme : DEFAULTS.theme,
    speed: SPEEDS.has(speed) ? speed : DEFAULTS.speed,
    follow: pick(bool(file.follow), DEFAULTS.follow),
    wrap: pick(bool(file.wrap), DEFAULTS.wrap),
    authors: pick(bool(file.authors), DEFAULTS.authors),
    github: pick(bool(env.CODE_VIZ_GITHUB), bool(file.github), DEFAULTS.github),
    usage: pick(bool(file.usage), DEFAULTS.usage),
    usagePeriod: PERIODS.has(file.usagePeriod) ? file.usagePeriod : DEFAULTS.usagePeriod,
    sessionTokenBudget: positive(file.sessionTokenBudget, DEFAULTS.sessionTokenBudget),
    burnWindowMinutes: Math.min(120, Math.max(5, positive(file.burnWindowMinutes, DEFAULTS.burnWindowMinutes))),
    terminalScreen: pick(bool(file.terminalScreen), DEFAULTS.terminalScreen),
    browserScreen: pick(bool(file.browserScreen), DEFAULTS.browserScreen),
    terminalColor: COLORS.has(file.terminalColor) ? file.terminalColor : DEFAULTS.terminalColor,
    screenLines: Math.round(Math.min(2000, Math.max(10, positive(file.screenLines, DEFAULTS.screenLines)))),
    checkForUpdates: pick(bool(env.CODE_VIZ_CHECK_UPDATES), bool(file.checkForUpdates), DEFAULTS.checkForUpdates),
    updateCheckIntervalHours: file.updateCheckIntervalHours === 0 ? 0 : Math.min(168, positive(file.updateCheckIntervalHours, DEFAULTS.updateCheckIntervalHours)),
    updateOn: UPDATE_ON.has(file.updateOn) ? file.updateOn : DEFAULTS.updateOn,
    error,
  };
}
function positive(v, fallback) {
  const n = Number(v);
  return v != null && v !== '' && Number.isFinite(n) && n > 0 ? n : fallback;
}

// The options the viewer applies at page load (as defaults for its footer toggles).
function viewerOptions(cfg) {
  const c = cfg || load();
  return { theme: c.theme, speed: c.speed, follow: c.follow, wrap: c.wrap, authors: c.authors, usage: c.usage, terminalColor: c.terminalColor };
}

module.exports = { HOME, FILE, DEFAULTS, readFile, load, viewerOptions };
