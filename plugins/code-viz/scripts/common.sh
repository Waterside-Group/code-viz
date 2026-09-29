# Shared by the hook scripts and bin/code-viz (sourced, not run): where Code Viz keeps its
# settings, which port the server uses, whether to auto-open the viewer, and where Node.js is.
# server/config.js reads the same settings for the Node side.

CV_HOME="${CODE_VIZ_HOME:-$HOME/.claude/code-viz}"
CV_CONF="$CV_HOME/config.json"

# Port: CODE_VIZ_PORT, else "port" in the config file, else 4455.
cv_port() {
  case "${CODE_VIZ_PORT:-}" in
    '' | *[!0-9]*) ;;
    *) printf '%s\n' "$CODE_VIZ_PORT"; return ;;
  esac
  cv_p=""
  if [ -f "$CV_CONF" ]; then
    cv_p="$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$CV_CONF" 2>/dev/null | head -n 1)"
  fi
  printf '%s\n' "${cv_p:-4455}"
}

# Auto-open (succeeds when on): CODE_VIZ_AUTO_OPEN, else "autoOpen" in the config file, else on.
cv_auto_open() {
  case "$(printf '%s' "${CODE_VIZ_AUTO_OPEN:-}" | tr 'A-Z' 'a-z')" in
    0 | false | off | no) return 1 ;;
    1 | true | on | yes) return 0 ;;
  esac
  ! grep -q '"autoOpen"[[:space:]]*:[[:space:]]*false' "$CV_CONF" 2>/dev/null
}

# Node.js: the one on PATH, else a common install location (Homebrew, system, Volta, fnm, and
# the newest nvm version). Hooks can run with a shorter PATH than your shell has.
cv_node() {
  cv_n="$(command -v node 2>/dev/null)"
  if [ -z "$cv_n" ]; then
    for cv_c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node "$HOME/.volta/bin/node" "$HOME/.local/share/fnm/aliases/default/bin/node"; do
      if [ -x "$cv_c" ]; then cv_n="$cv_c"; break; fi
    done
  fi
  if [ -z "$cv_n" ]; then
    cv_major=0
    for cv_c in "$HOME"/.nvm/versions/node/v*/bin/node; do
      [ -x "$cv_c" ] || continue
      cv_v="${cv_c#"$HOME"/.nvm/versions/node/v}"
      cv_v="${cv_v%%.*}"
      case "$cv_v" in '' | *[!0-9]*) continue ;; esac
      if [ "$cv_v" -gt "$cv_major" ]; then cv_n="$cv_c"; cv_major="$cv_v"; fi
    done
  fi
  printf '%s\n' "$cv_n"
}
