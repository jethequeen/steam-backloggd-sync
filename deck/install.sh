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
systemctl --user enable backloggd-watch.service
# Restart so a re-run after git pull picks up the new script.
systemctl --user restart backloggd-watch.service
set -a; . "$env_file"; set +a
python3 "$HOME/.local/bin/backloggd-watch.py" --test
echo "Service : $(systemctl --user is-active backloggd-watch)"
