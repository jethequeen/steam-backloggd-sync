#!/usr/bin/env python3
"""Reports Eden (Switch emulator) play time from an Android phone to steam-backloggd-sync.

Runs in Termux, every 15 minutes (termux-job-scheduler) and whenever MacroDroid starts it.
Eden keeps one cumulative total per game in play_time/playtime.bin, inside its private
Android/data folder, which only Shizuku can read: the file is fetched with rish. The file
is a run of 16-byte entries, Title ID then seconds played, both little-endian uint64.

Each run compares those totals with the ones seen last time, credits the difference to
today and sends today's total per game to the site's /api/control endpoint, like the
Steam Deck watcher does. Games are named from titledb (looked up once per new game).

If rish fails (Shizuku stops after every reboot), a Termux notification says so.

Config: ~/.config/backloggd-eden.env with SITE_URL and SYNC_TOKEN.
The first run only records Eden's totals: time played before the install is never sent.
  --scan         print Eden's totals with game names and exit
  --test         check that rish and the site both answer
"""
import base64
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import date, timedelta
from pathlib import Path

PLAYTIME_FILE = '/sdcard/Android/data/dev.eden.eden_emulator/files/play_time/playtime.bin'
TITLEDB_URL = 'https://raw.githubusercontent.com/blawar/titledb/master/US.en.json'
HOME = Path.home()
ENV_FILE = HOME / '.config/backloggd-eden.env'
STATE_FILE = HOME / '.local/state/backloggd-eden.json'
NOTIFY_ID = 'backloggd-eden'
KEEP_DAYS = 7
DEVICE = 'phone'
SYSTEM = 'switch'


class RishError(Exception):
    pass


def load_env():
    try:
        for line in ENV_FILE.read_text().splitlines():
            key, sep, value = line.partition('=')
            if sep and key.strip() and key.strip() not in os.environ:
                os.environ[key.strip()] = value.strip()
    except OSError:
        pass


def rish_path():
    found = os.environ.get('RISH') or shutil.which('rish')
    if found:
        return found
    prefix = Path(os.environ.get('PREFIX', '/data/data/com.termux/files/usr'))
    for candidate in (prefix / 'bin/rish', HOME / 'rish', HOME / 'bin/rish'):
        if candidate.exists():
            return str(candidate)
    raise RishError('rish introuvable')


def read_totals():
    """Eden's totals as {title id: seconds}. Raises RishError when Shizuku does not answer."""
    # base64 keeps the binary file intact through rish's terminal; the marker tells a
    # missing file (Eden never saved a time) apart from rish failing.
    cmd = f'echo RISH_OK; [ -f {PLAYTIME_FILE} ] && base64 {PLAYTIME_FILE}'
    try:
        out = subprocess.run([rish_path(), '-c', cmd], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as err:
        raise RishError(str(err)) from err
    if 'RISH_OK' not in out.stdout:
        raise RishError((out.stderr or out.stdout).strip()[:200] or f'code {out.returncode}')
    data = base64.b64decode(''.join(out.stdout.split('RISH_OK', 1)[1].split()))
    return parse(data)


def parse(data):
    totals = {}
    for i in range(0, len(data) - len(data) % 16, 16):
        title_id, seconds = struct.unpack('<QQ', data[i:i + 16])
        if title_id and seconds:
            totals[f'{title_id:016X}'] = seconds
    return totals


def notify(title, text):
    try:
        subprocess.run(['termux-notification', '--id', NOTIFY_ID, '--title', title, '--content', text], timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        pass


def clear_notification():
    try:
        subprocess.run(['termux-notification-remove', NOTIFY_ID], timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        pass


def lookup_names(title_ids):
    """Names from titledb for these Title IDs. Streams the file line by line (it is ~90 MB)
    and stops once every id is found; the first entry wins over later editions."""
    wanted, found = set(title_ids), {}
    current = None
    req = urllib.request.Request(TITLEDB_URL, headers={'Accept-Encoding': 'identity'})
    with urllib.request.urlopen(req, timeout=60) as res:
        for raw in res:
            line = raw.decode('utf-8', 'replace').strip()
            if line.startswith('"id":'):
                m = re.match(r'"id": "([0-9A-Fa-f]{16})"', line)
                current = m[1].upper() if m else None
            elif line.startswith('"name":') and current in wanted and current not in found:
                try:
                    name = json.loads(line[len('"name":'):].rstrip(',').strip())
                except ValueError:
                    continue
                if name:
                    found[current] = re.sub(r'[™®©]', '', name).strip()
                    if len(found) == len(wanted):
                        break
    return found


def load_state():
    try:
        return json.loads(STATE_FILE.read_text())
    except (OSError, ValueError):
        return None


def save_state(state):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix('.tmp')
    tmp.write_text(json.dumps(state, indent=1))
    tmp.replace(STATE_FILE)


def post(site, token, payload):
    req = urllib.request.Request(
        f'{site.rstrip("/")}/api/control',
        data=json.dumps(payload).encode(),
        method='POST',
        headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=20) as res:
        return 200 <= res.status < 300


def test_connection(site, token):
    try:
        post(site, token, {'action': 'ping', 'device': DEVICE})
        return 'OK : le site répond et accepte le token.'
    except urllib.error.HTTPError as err:
        if err.code == 401:
            return f'ÉCHEC : token refusé (401). Vérifie SYNC_TOKEN dans {ENV_FILE}.'
        if err.code == 404:
            return f'ÉCHEC : adresse introuvable (404). Vérifie SITE_URL dans {ENV_FILE}.'
        return f'ÉCHEC : le site a répondu {err.code}.'
    except Exception as err:
        return f'ÉCHEC : site injoignable ({err}).'


def credit(state, totals, today):
    """Moves the difference since last time onto today's totals."""
    for tid, seconds in totals.items():
        delta = seconds - state['known'].get(tid, 0)
        state['known'][tid] = seconds
        # A smaller total means Eden's data was reset: start again from it.
        if delta <= 0:
            continue
        day = state['days'].setdefault(today, {})
        day[tid] = day.get(tid, 0) + delta / 60
        key = f'{today}|{tid}'
        if key not in state['dirty']:
            state['dirty'].append(key)


def flush(state, site, token):
    """Sends every pending day total; anything that fails stays pending for the next run."""
    unnamed = {k.split('|', 1)[1] for k in state['dirty']} - set(state['names'])
    if unnamed:
        try:
            state['names'].update(lookup_names(unnamed))
        except Exception as err:
            print(f'titledb lookup failed: {err}', file=sys.stderr)
            return
        for tid in unnamed - set(state['names']):
            # Not in titledb: the page offers to pick the Backloggd entry by hand.
            state['names'][tid] = f'Switch {tid}'

    still_dirty = []
    for key in state['dirty']:
        day, tid = key.split('|', 1)
        minutes = state['days'].get(day, {}).get(tid)
        if minutes is None:
            continue
        payload = {'action': 'play', 'name': state['names'][tid], 'date': day, 'minutes': round(minutes, 1),
                   'system': SYSTEM, 'device': DEVICE}
        try:
            post(site, token, payload)
            print(f'{day} {state["names"][tid]} : {round(minutes)} min', flush=True)
        except Exception as err:
            print(f'send failed for {tid}: {err}', file=sys.stderr)
            still_dirty.append(key)
    state['dirty'] = still_dirty


def main():
    load_env()
    if '--scan' in sys.argv:
        totals = read_totals()
        names = (load_state() or {}).get('names', {})
        missing = set(totals) - set(names)
        if missing:
            names.update(lookup_names(missing))
        for tid, seconds in sorted(totals.items(), key=lambda t: -t[1]):
            print(f'{tid}  {seconds // 3600} h {seconds % 3600 // 60:02d} min  {names.get(tid, "?")}')
        return

    site, token = os.environ.get('SITE_URL'), os.environ.get('SYNC_TOKEN')
    if not site or not token:
        sys.exit(f'SITE_URL et SYNC_TOKEN manquent dans {ENV_FILE}')
    if '://' not in site:
        site = f'https://{site}'

    if '--test' in sys.argv:
        try:
            read_totals()
            print('OK : Shizuku répond, Eden est lisible.')
        except RishError as err:
            print(f'ÉCHEC : rish ne répond pas ({err}). Ouvre Shizuku et démarre-le.')
        print(test_connection(site, token))
        return

    try:
        totals = read_totals()
    except RishError as err:
        print(f'rish failed: {err}', file=sys.stderr)
        notify('Backloggd : Shizuku arrêté', 'Ouvre Shizuku et démarre-le pour que le temps de jeu Eden soit suivi.')
        sys.exit(1)
    clear_notification()

    state = load_state()
    if state is None:
        # Counting starts now: the totals Eden already holds are the baseline, never sent.
        state = {'known': dict(totals), 'days': {}, 'dirty': [], 'names': {}}

    today = date.today().isoformat()
    credit(state, totals, today)
    cutoff = (date.today() - timedelta(days=KEEP_DAYS)).isoformat()
    state['days'] = {d: v for d, v in state['days'].items() if d >= cutoff}
    state['dirty'] = [k for k in state['dirty'] if k.split('|', 1)[0] >= cutoff]
    if state['dirty']:
        flush(state, site, token)
    else:
        # Nothing played: still tell the site this run happened, so the page shows the phone is alive.
        try:
            post(site, token, {'action': 'ping', 'device': DEVICE})
        except Exception as err:
            print(f'ping failed: {err}', file=sys.stderr)
    save_state(state)


if __name__ == '__main__':
    main()
