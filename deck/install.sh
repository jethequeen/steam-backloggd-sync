#!/usr/bin/env bash
# Installs the play-time watcher as a user service on a Steam Deck (Desktop mode, Konsole).
set -euo pipefail
cd "$(dirname "$0")"

install -Dm755 backloggd-watch.py "$HOME/.local/bin/backloggd-watch.py"
install -Dm644 backloggd-watch.service "$HOME/.config/systemd/user/backloggd-watch.service"

env_file="$HOME/.config/backloggd-watch.env"
if [ ! -f "$env_file" ]; then
    read -rp "Adresse du site (ex. https://backloggd.netlify.app) : " site
    read -rsp "SYNC_TOKEN : " token; echo
    umask 077
    printf 'SITE_URL=%s\nSYNC_TOKEN=%s\n' "$site" "$token" > "$env_file"
fi

systemctl --user daemon-reload
systemctl --user enable --now backloggd-watch.service
echo "Installé. Suivi en direct : journalctl --user -u backloggd-watch -f"
