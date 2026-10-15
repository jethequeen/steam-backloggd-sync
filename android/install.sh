#!/data/data/com.termux/files/usr/bin/bash
# Installs the Eden play-time reporter in Termux. Run with:
#   curl -sL https://raw.githubusercontent.com/jethequeen/steam-backloggd-sync/main/android/install.sh | bash
# Needs the Termux:API app, and rish set up for Shizuku. Re-run it to update.
set -euo pipefail
REF="${REF:-main}"
RAW="https://raw.githubusercontent.com/jethequeen/steam-backloggd-sync/$REF/android"
BIN="$HOME/.local/bin"
ENV_FILE="$HOME/.config/backloggd-eden.env"
STATE_FILE="$HOME/.local/state/backloggd-eden.json"

echo "Installation des paquets (python, termux-api)…"
pkg install -y python termux-api >/dev/null 2>&1 || pkg install -y python termux-api

mkdir -p "$BIN" "$HOME/.config" "$HOME/.local/state"
curl -fsSL "$RAW/backloggd-eden.py" -o "$BIN/backloggd-eden.py"
chmod 755 "$BIN/backloggd-eden.py"
# What the scheduled job runs; keeps the last runs in a small log.
cat > "$BIN/backloggd-eden" <<SH
#!/data/data/com.termux/files/usr/bin/sh
log="\$HOME/.local/state/backloggd-eden.log"
[ -f "\$log" ] && tail -n 200 "\$log" > "\$log.tmp" && mv "\$log.tmp" "\$log"
echo "--- \$(date '+%F %T')" >> "\$log"
export PATH="$PREFIX/bin:\$PATH"
exec "$PREFIX/bin/python" "$BIN/backloggd-eden.py" "\$@" >> "\$log" 2>&1
SH
chmod 755 "$BIN/backloggd-eden"

if [ ! -f "$ENV_FILE" ]; then
    # Pasting into a phone terminal can bring invisible characters: keep printable ones only.
    read -rp "Colle le SYNC_TOKEN : " token < /dev/tty
    token="$(printf '%s' "$token" | tr -cd '[:graph:]')"
    umask 077
    printf 'SITE_URL=https://backloggd.netlify.app\nSYNC_TOKEN=%s\n' "$token" > "$ENV_FILE"
    umask 022
fi

if [ ! -f "$STATE_FILE" ]; then
    read -rp "Envoyer à Backloggd le temps déjà dans Eden (daté d'aujourd'hui) ? [o/n] " answer < /dev/tty
    case "$answer" in [oOyY]*) init=yes ;; *) init=no ;; esac
    python "$BIN/backloggd-eden.py" --init "$init" || true
fi

# Every 15 minutes (Android's shortest period), kept across reboots.
termux-job-scheduler --job-id 4242 --period-ms 900000 --persisted true --script "$BIN/backloggd-eden" >/dev/null

python "$BIN/backloggd-eden.py" --test
echo "Installé : vérification aux 15 minutes."
