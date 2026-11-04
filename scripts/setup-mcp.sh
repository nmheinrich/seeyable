#!/bin/sh
# Local Docker setup only. Never edits an agent's settings or prints a token.
set -eu
umask 077

setup_agent=''
setup_clipboard=1
setup_interactive=1
while [ "$#" -gt 0 ]; do
  case "$1" in
    --agent)
      [ "$#" -ge 2 ] || { echo 'Missing agent name.' >&2; exit 1; }
      setup_agent=$2; setup_interactive=0; shift 2 ;;
    --no-clipboard) setup_clipboard=0; shift ;;
    --help)
      echo 'Usage: sh setup-mcp.sh [--agent chatgpt|claude|claude-code|muse] [--no-clipboard]'
      exit 0 ;;
    *) echo 'Unknown option. Use --help.' >&2; exit 1 ;;
  esac
done

if [ -z "$setup_agent" ]; then
  printf '\nConnect Seeyable to your agent\n\n1) ChatGPT desktop / Codex\n2) Claude Desktop\n3) Claude Code\n4) Muse Code\n\nChoose 1–4: '
  read -r setup_choice
  case "$setup_choice" in
    1) setup_agent=chatgpt ;; 2) setup_agent=claude ;;
    3) setup_agent=claude-code ;; 4) setup_agent=muse ;;
    *) echo 'Choose a number from 1 to 4.' >&2; exit 1 ;;
  esac
fi
case "$setup_agent" in
  chatgpt|claude|claude-code|muse) ;;
  *) echo 'Unknown agent. Choose chatgpt, claude, claude-code, or muse.' >&2; exit 1 ;;
esac

setup_script_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
if [ -f "$setup_script_dir/compose.yaml" ]; then
  setup_root=$setup_script_dir
else
  setup_root=$(CDPATH= cd -P "$setup_script_dir/.." && pwd)
fi
if [ ! -f "$setup_root/compose.yaml" ] || [ ! -f "$setup_root/docker/setup-mcp.mjs" ]; then
  echo 'Keep this helper with the extracted Seeyable folder.' >&2; exit 1
fi
setup_docker=$(command -v docker || true)
if [ -z "$setup_docker" ] && [ -x /Applications/Docker.app/Contents/Resources/bin/docker ]; then
  setup_docker=/Applications/Docker.app/Contents/Resources/bin/docker
fi
if [ -z "$setup_docker" ]; then
  echo 'Docker was not found. Install/open Docker Desktop, then try again.' >&2; exit 1
fi
compose() { "$setup_docker" compose --project-directory "$setup_root" "$@"; }
if ! compose exec -T --user node seeyable true </dev/null >/dev/null 2>&1; then
  printf 'Start Seeyable first: in the extracted folder, run docker compose up --build.\nThen run this helper again.\n' >&2
  exit 1
fi

setup_output_dir="$setup_root/.seeyable-setup"
mkdir -p "$setup_output_dir"
case "$setup_agent" in
  chatgpt) setup_extension=toml ;; claude-code) setup_extension=txt ;; *) setup_extension=json ;;
esac
setup_output="$setup_output_dir/seeyable-$setup_agent.$setup_extension"
if ! compose exec -T --user node \
  -e "SEEYABLE_SETUP_ROOT=$setup_root" \
  -e "SEEYABLE_SETUP_DOCKER=$setup_docker" \
  -e "SEEYABLE_SETUP_AGENT=$setup_agent" \
  seeyable node --input-type=module < "$setup_root/docker/setup-mcp.mjs" > "$setup_output"; then
  echo 'Could not prepare setup. Check that the running container matches this download.' >&2
  exit 1
fi
chmod 600 "$setup_output"
printf '\nYour configuration (no API key or token needed here):\n\n'
cat "$setup_output"
printf '\nSaved to: %s\n' "$setup_output"
case "$setup_agent" in
  chatgpt) printf '\nChatGPT desktop: Settings → MCP servers → Add server → STDIO.\nUse the command and args above; leave Environment variables empty.\nOr merge the entry into ~/.codex/config.toml for Codex. Save/restart.\n' ;;
  claude) printf '\nClaude Desktop: Settings → Developer → Edit Config.\nMerge this server with existing settings, then quit and reopen Claude.\n' ;;
  claude-code) printf '\nRun the generated registration command above, then check /mcp in Claude Code.\n' ;;
  muse) printf '\nMerge this entry into ~/.config/muse/settings.json.\nPreserve existing settings, start a new Muse Code session, then check /mcp.\n' ;;
esac

if [ "$setup_interactive" -eq 1 ]; then
  printf '\nAfter adding the server, press Enter to copy the pairing token: '
  read -r setup_ready
fi
setup_token=$(compose exec -T --user node seeyable cat /home/node/.seeyable/bridge-6123.token </dev/null)
if [ "${#setup_token}" -ne 64 ]; then
  echo 'The pairing token was not valid. Check the container configuration.' >&2; exit 1
fi
case "$setup_token" in *[!0-9a-f]*) echo 'The pairing token was not valid.' >&2; exit 1 ;; esac
setup_copied=0
if [ "$setup_clipboard" -eq 1 ]; then
  if command -v pbcopy >/dev/null 2>&1; then
    if printf '%s' "$setup_token" | pbcopy; then setup_copied=1; fi
  elif command -v wl-copy >/dev/null 2>&1; then
    if printf '%s' "$setup_token" | wl-copy; then setup_copied=1; fi
  elif command -v xclip >/dev/null 2>&1; then
    if printf '%s' "$setup_token" | xclip -selection clipboard; then setup_copied=1; fi
  fi
fi
unset setup_token
if [ "$setup_copied" -eq 1 ]; then
  printf '\nPairing token copied. Keep it private; do not paste it into an agent chat.\n'
else
  printf '\nToken ready, but clipboard copying is unavailable or disabled.\nFrom the extracted folder, display it locally with:\n\ndocker compose exec -T --user node seeyable cat /home/node/.seeyable/bridge-6123.token\n'
fi
printf '\nIn Seeyable: Settings → Advanced → Developer view → MCP bridge.\nPaste the token, leave port 6123, and choose Connect bridge.\nKeep Chrome and the agent open. No Environment variables are needed.\nThis generated client setup still needs the connection check in MCP-SETUP.md.\n'
