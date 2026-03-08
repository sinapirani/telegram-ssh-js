#!/usr/bin/env bash
# install.sh for telegram-ssh-js — interactive installer with node version check (node >= 18)
set -euo pipefail

REPO_URL="https://github.com/sinapirani/telegram-ssh-js.git"
APP_DIR="/opt/telegram-ssh-js"
CONFIG_DIR="$HOME/.telegram-ssh-js"
CONFIG_FILE="$CONFIG_DIR/install-config"

# helpers
info(){ printf "\n[INFO] %s\n" "$*"; }
err(){ printf "\n[ERROR] %s\n" "$*" >&2; }
prompt(){ local p="$1"; local def="${2-}"; read -rp "$p" out; if [[ -z "$out" && -n "$def" ]]; then out="$def"; fi; printf "%s" "$out"; }
confirm(){ local p="$1"; local def="${2:-n}"; read -rp "$p" ans; ans=${ans:-$def}; [[ "$ans" =~ ^[Yy]$ ]]; }

ensure_sudo(){
  if ! sudo -n true 2>/dev/null; then
    info "sudo is required for some operations. You may be prompted for your password."
  fi
}

# Check node version. If missing or major < 18 -> install Node.js 18 + npm via NodeSource.
ensure_node_18(){
  need_install=0
  if ! command -v node >/dev/null 2>&1; then
    info "node not found."
    need_install=1
  else
    ver=$(node -v 2>/dev/null || echo "")
    if [[ "$ver" =~ ^v([0-9]+) ]]; then
      major="${BASH_REMATCH[1]}"
      info "Detected node version: $ver (major: $major)"
      if (( major < 18 )); then
        info "Node major version < 18 -> will install Node.js 18."
        need_install=1
      else
        info "Node version is OK (>=18)."
      fi
    else
      info "Could not parse node version: $ver"
      need_install=1
    fi
  fi

  if (( need_install )); then
    ensure_sudo
    info "Installing Node.js 24 (NodeSource)..."
    # add NodeSource repo and install nodejs 18
    curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
    sudo apt-get install -y nodejs
    # ensure npm exists (nodejs package provides npm). If not, install npm
    if ! command -v npm >/dev/null 2>&1; then
      info "npm not found after node install — installing npm..."
      sudo apt-get install -y npm
    fi
    info "Node.js and npm installed. New node version: $(node -v || echo 'unknown')"
  fi
}

install_prereqs(){
  info "Updating packages and installing prerequisites (git, curl, build-essential)..."
  ensure_sudo
  sudo apt update -y
  sudo apt upgrade -y
  sudo apt install -y git curl build-essential
  ensure_node_18
}

write_config(){
  local chat_id="$1"
  local bot_token="$2"
  local max_retry="$3"
  local owner_ids="$4"

  mkdir -p "$CONFIG_DIR"
  chmod 700 "$CONFIG_DIR"
  cat > "$CONFIG_FILE" <<EOF
CHAT_ID="${chat_id}"
BOT_TOKEN="${bot_token}"
MAX_RETRY="${max_retry}"
OWNER_IDS="${owner_ids}"
EOF
  chmod 600 "$CONFIG_FILE"
  info "Saved installation config to $CONFIG_FILE"
}

read_config(){
  if [[ ! -f "$CONFIG_FILE" ]]; then
    err "Config file not found at $CONFIG_FILE"
    return 1
  fi
  # shellcheck source=/dev/null
  source "$CONFIG_FILE"
  return 0
}

pm2_install_and_reload(){
  info "Installing pm2 globally (if missing) and reloading..."
  # install pm2 globally with sudo to ensure system-wide availability
  sudo npm i -g pm2
}

start_app_from_env(){
  if ! read_config; then
    err "Cannot start: config missing. Run Install first."
    return 1
  fi

  if [[ -z "${BOT_TOKEN-}" || -z "${CHAT_ID-}" ]]; then
    err "BOT_TOKEN or CHAT_ID empty in $CONFIG_FILE"
    return 1
  fi

  if [[ -z "${MAX_RETRY-}" ]]; then
    MAX_RETRY=3
  fi
  if [[ -z "${OWNER_IDS-}" ]]; then
    OWNER_IDS="${CHAT_ID}"
  fi

  if [[ ! -d "$APP_DIR" ]]; then
    err "$APP_DIR does not exist. Is the project installed?"
    return 1
  fi

  cd "$APP_DIR"
  pm2_install_and_reload

  info "Starting bot with pm2..."
  pm2 start bot.js --name telegram-ssh-js -- --bot_token "${BOT_TOKEN}" --chat_id "${CHAT_ID}" --owner_ids "${OWNER_IDS}" --max_retry "${MAX_RETRY}"
  pm2 save || true
  info "Bot started (pm2 name: telegram-ssh-js)"
}

do_install(){
  if [[ -d "$APP_DIR" ]]; then
    info "$APP_DIR already exists."
    if ! confirm "Reinstall (will remove and reinstall)? (y/N): " "n"; then
      info "Installation aborted by user."
      return 0
    fi
    info "Removing existing install..."
    sudo pm2 kill || true
    sudo rm -rf "$APP_DIR"
  fi

  chat_id=$(prompt "Chat id: ")
  if [[ -z "$chat_id" ]]; then err "Chat id is required"; return 1; fi

  bot_token=$(prompt "Bot Token: ")
  if [[ -z "$bot_token" ]]; then err "Bot token is required"; return 1; fi

  max_retry=$(prompt "Max Retry (default 3): " "3")
  if ! [[ "$max_retry" =~ ^[0-9]+$ ]]; then err "Max Retry must be a number"; return 1; fi

  owner_ids="$chat_id"

  write_config "$chat_id" "$bot_token" "$max_retry" "$owner_ids"

  install_prereqs

  info "Cloning repository to $APP_DIR..."
  sudo mkdir -p "$APP_DIR"
  sudo chown "$USER":"$USER" "$APP_DIR"
  git clone "$REPO_URL" "$APP_DIR"

  info "Installing npm dependencies..."
  cd "$APP_DIR"
  npm i

  pm2_install_and_reload

  info "Starting bot..."
  start_app_from_env

  info "Install complete."
}

do_stop(){
  info "Stopping all pm2 processes (pm2 kill)..."
  pm2 kill || sudo pm2 kill || true
  info "pm2 killed."
}

do_start(){
  if [[ ! -f "$CONFIG_FILE" ]]; then
    err "Config file not found at $CONFIG_FILE. Please run Install first."
    return 1
  fi
  start_app_from_env
}

do_uninstall(){
  if ! confirm "Uninstall will stop and remove files under $APP_DIR and $CONFIG_DIR. Continue? (y/N): " "n"; then
    info "Uninstall aborted."
    return 0
  fi

  info "Killing pm2..."
  pm2 kill || sudo pm2 kill || true

  info "Removing application files..."
  sudo rm -rf "$APP_DIR" || true

  info "Removing config directory..."
  rm -rf "$CONFIG_DIR" || true

  info "Uninstall complete."
}

print_menu(){
  cat <<'HEADER'

                                         (   (       )  
  *   )    (                             )\ ))\ ) ( /(  
` )  /(  ( )\  (  (  ( (      )    )    (()/(()/( )\()) 
 ( )(_))))((_)))\ )\))()(  ( /(   (      /(_))(_)|(_)\  
(_(_())/((_) /((_|(_))(()\ )(_))  )\  ' (_))(_))  _((_) 
|_   _(_))| (_))  (()(_|(_|(_)_ _((_))  / __/ __|| || | 
  | | / -_) / -_)/ _` | '_/ _` | '  \() \__ \__ \| __ | 
  |_| \___|_\___|\__, |_| \__,_|_|_|_|  |___/___/|_||_| 
                 |___/                                  

Select an option:
1) Install
2) Stop
3) Start
4) Uninstall
q) Quit

HEADER
}

main(){
  print_menu
  read -rp "Choose [1-4,q]: " choice
  case "$choice" in
    1) do_install ;;
    2) do_stop ;;
    3) do_start ;;
    4) do_uninstall ;;
    q|Q) info "Exit."; exit 0 ;;
    *) err "Invalid choice"; exit 1 ;;
  esac
}

main "$@"