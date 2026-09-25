# shellcheck shell=bash
# Local deploy configuration for the shell scripts (sourced by deploy.sh and staging_access.sh; bash 3.2+).
# The file is ~/.config/gokyuzu/deploy.env, or $GOKYUZU_DEPLOY_ENV; the keys and rules are in deploy.env.example
# (same parser as deploy_config.py and config.mjs). The file is parsed, never sourced, and no value is ever printed.
#
#   cfg_set VAR KEY                  VAR=<KEY from the file>; stops the script, naming KEY, if it is missing/placeholder
#   cfg_profile VAR KEY DEFAULT      VAR=<$KEY from the environment, else KEY from the file, else DEFAULT>
#   cfg_check KEY...                 stops (naming every missing key) unless all KEYs are set; prints key names only

GOKYUZU_DEPLOY_ENV_FILE="${GOKYUZU_DEPLOY_ENV:-$HOME/.config/gokyuzu/deploy.env}"
if [ -n "${GOKYUZU_DEPLOY_ENV:-}" ]; then GOKYUZU_DEPLOY_ENV_SHOWN="$GOKYUZU_DEPLOY_ENV"; else GOKYUZU_DEPLOY_ENV_SHOWN='~/.config/gokyuzu/deploy.env'; fi

# the last value of KEY in the file (surrounding quotes removed), or nothing
cfg_value() {
  [ -f "$GOKYUZU_DEPLOY_ENV_FILE" ] || return 0
  awk -v k="$1" '
    { line = $0; sub(/^[ \t]+/, "", line) }
    line == "" || line ~ /^#/ { next }
    { sub(/^export[ \t]+/, "", line); eq = index(line, "="); if (!eq) next
      key = substr(line, 1, eq - 1); sub(/[ \t]+$/, "", key); if (key != k) next
      val = substr(line, eq + 1); sub(/^[ \t]+/, "", val); sub(/[ \t\r]+$/, "", val)
      if (length(val) >= 2 && (val ~ /^".*"$/ || val ~ /^\047.*\047$/)) val = substr(val, 2, length(val) - 2)
      out = val; found = 1 }
    END { if (found) print out }' "$GOKYUZU_DEPLOY_ENV_FILE"
}

cfg_missing_file() {
  echo "Deploy config not found: $GOKYUZU_DEPLOY_ENV_SHOWN" >&2
  echo "  Copy tools/deploy/deploy.env.example there (chmod 600) and fill it in, or set GOKYUZU_DEPLOY_ENV." >&2
  exit 1
}

cfg_set() {
  local v
  [ -f "$GOKYUZU_DEPLOY_ENV_FILE" ] || cfg_missing_file
  v=$(cfg_value "$2")
  if [ -z "$v" ] || [ "$v" = "REPLACE_ME" ]; then
    echo "Deploy config: key $2 is missing, empty or still REPLACE_ME in $GOKYUZU_DEPLOY_ENV_SHOWN (see tools/deploy/deploy.env.example)." >&2
    exit 1
  fi
  printf -v "$1" '%s' "$v"
}

cfg_profile() {
  local v
  v="${!2:-}"
  [ -n "$v" ] || v=$(cfg_value "$2")
  [ -n "$v" ] && [ "$v" != "REPLACE_ME" ] || v="$3"
  printf -v "$1" '%s' "$v"
}

cfg_check() {
  local k v bad=""
  [ -f "$GOKYUZU_DEPLOY_ENV_FILE" ] || cfg_missing_file
  for k in "$@"; do
    v=$(cfg_value "$k")
    if [ -z "$v" ] || [ "$v" = "REPLACE_ME" ]; then bad="$bad $k"; fi
  done
  if [ -n "$bad" ]; then
    echo "Deploy config $GOKYUZU_DEPLOY_ENV_SHOWN: missing, empty or REPLACE_ME:$bad (see tools/deploy/deploy.env.example)." >&2
    exit 1
  fi
  case "$(ls -ln "$GOKYUZU_DEPLOY_ENV_FILE" | cut -c5-10)" in
    ------) ;;
    *) echo "WARNING: $GOKYUZU_DEPLOY_ENV_SHOWN is readable by other users: chmod 600 it." >&2 ;;
  esac
  echo "Deploy config OK ($GOKYUZU_DEPLOY_ENV_SHOWN): $* (values not shown)"
}
