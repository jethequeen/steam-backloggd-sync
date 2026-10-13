#!/usr/bin/env python3
"""Reports emulated play time from a Steam Deck to steam-backloggd-sync.

Steam hides the names of non-Steam games from its public API, so this runs on the
Deck instead. Every 30 seconds it looks for a running process whose command line
holds a ROM path (EmuDeck keeps them under .../Emulation/roms/), credits the elapsed
time to that game, and sends the day's total to the site's /api/control endpoint.

Config (environment, normally from ~/.config/backloggd-watch.env):
  SITE_URL     https://<site>.netlify.app
  SYNC_TOKEN   same token as the Netlify site
  ROM_MARKER   path fragment that identifies a ROM (default: /roms/)

Run with --scan to print what it detects right now and exit, or --test to check
that the site accepts this Deck's address and token.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import date, timedelta
from pathlib import Path

POLL_SECONDS = 30
# A longer gap between polls means the Deck slept; that time is not play.
MAX_GAP_SECONDS = 90
SEND_EVERY_SECONDS = 300
KEEP_DAYS = 7
STATE_FILE = Path.home() / '.local/state/backloggd-watch.json'


def running_games(marker):
    """Names of the ROMs open in any process right now."""
    games = set()
    me = os.getpid()
    for pid in os.listdir('/proc'):
        if not pid.isdigit() or int(pid) == me:
            continue
        try:
            args = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
        except OSError:
            continue
        for raw in args:
            arg = raw.decode('utf-8', 'replace')
            if marker not in arg:
                continue
            name = Path(arg).name
            stem, dot, ext = name.rpartition('.')
            # A bare folder (".../roms/gc") is a system, not a game.
            if dot and stem and 1 <= len(ext) <= 5:
                games.add(stem)
    return games


def load_state():
    try:
        return json.loads(STATE_FILE.read_text())
    except (OSError, ValueError):
        return {'totals': {}, 'dirty': []}


def save_state(state):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix('.tmp')
    tmp.write_text(json.dumps(state))
    tmp.replace(STATE_FILE)


def post(site, token, payload):
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        f'{site.rstrip("/")}/api/control',
        data=body,
        method='POST',
        headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=15) as res:
        return 200 <= res.status < 300


def send(site, token, name, day, minutes):
    return post(site, token, {'action': 'play', 'name': name, 'date': day, 'minutes': round(minutes, 1)})


def test_connection(site, token):
    """One-line verdict a person can read off the screen."""
    try:
        post(site, token, {'action': 'ping'})
        return 'OK : le site répond et accepte le token.'
    except urllib.error.HTTPError as err:
        if err.code == 401:
            return 'ÉCHEC : token refusé (401). Vérifie SYNC_TOKEN dans ~/.config/backloggd-watch.env.'
        if err.code == 404:
            return 'ÉCHEC : adresse introuvable (404). Vérifie SITE_URL dans ~/.config/backloggd-watch.env.'
        return f'ÉCHEC : le site a répondu {err.code}.'
    except Exception as err:
        return f'ÉCHEC : site injoignable ({err}). Vérifie SITE_URL et le Wi-Fi.'


def flush(state, site, token):
    """Sends every pending day total; anything that fails stays pending."""
    still_dirty = []
    for key in state['dirty']:
        day, name = key.split('|', 1)
        minutes = state['totals'].get(day, {}).get(name)
        if minutes is None:
            continue
        try:
            send(site, token, name, day, minutes)
        except Exception as err:  # offline, site down: retry next flush
            print(f'send failed for {name}: {err}', file=sys.stderr)
            still_dirty.append(key)
    state['dirty'] = still_dirty


def main():
    marker = os.environ.get('ROM_MARKER', '/roms/')
    if '--scan' in sys.argv:
        print(sorted(running_games(marker)) or 'no game running')
        return

    site, token = os.environ.get('SITE_URL'), os.environ.get('SYNC_TOKEN')
    if not site or not token:
        sys.exit('SITE_URL and SYNC_TOKEN must be set (see ~/.config/backloggd-watch.env)')
    if '://' not in site:
        site = f'https://{site}'
    if '--test' in sys.argv:
        print(test_connection(site, token))
        return

    state = load_state()
    last_poll = time.time()
    last_send = 0.0
    previous = set()

    while True:
        time.sleep(POLL_SECONDS)
        now = time.time()
        gap, last_poll = now - last_poll, now
        games = running_games(marker)
        today = date.today().isoformat()

        if games and gap <= MAX_GAP_SECONDS:
            day = state['totals'].setdefault(today, {})
            for name in games:
                day[name] = day.get(name, 0) + gap / 60
                key = f'{today}|{name}'
                if key not in state['dirty']:
                    state['dirty'].append(key)
            print(f'playing {", ".join(sorted(games))}', flush=True)

        cutoff = (date.today() - timedelta(days=KEEP_DAYS)).isoformat()
        state['totals'] = {d: v for d, v in state['totals'].items() if d >= cutoff}

        # Send when a game closes, and every few minutes while one runs.
        stopped = previous - games
        if state['dirty'] and (stopped or now - last_send >= SEND_EVERY_SECONDS):
            flush(state, site, token)
            last_send = now
        previous = games
        save_state(state)


if __name__ == '__main__':
    main()
