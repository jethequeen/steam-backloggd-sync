import { getStore } from '@netlify/blobs';
import { getCurrentGame, getOwnedGames } from './steam.mjs';
import { AuthError, BackloggdClient } from './backloggd.mjs';
import { appendLog, cleanShortcutName, emptyState, forAccount, markFinishedGames, recordReportedPlay, pushToBackloggd, recordLiveGame, recordPlaytime } from './sync.mjs';

const STATE_KEY = 'state';
// Kept apart from the state so the status endpoint can never print it.
const COOKIE_KEY = 'backloggd-session';

// Strong reads: the page saves a choice and starts a run right after, and an eventually
// consistent read there returned the state from before the choice, which the run then saved back.
export const store = () => getStore({ name: 'steam-backloggd', consistency: 'strong' });

export async function loadState() {
    return { ...emptyState(), ...((await store().get(STATE_KEY, { type: 'json' })) ?? {}) };
}

export const saveState = (state) => store().setJSON(STATE_KEY, state);

// Deck reports land under their own keys so the control endpoint never races the
// scheduled run over the state blob; the run folds them in.
const REPORT_PREFIX = 'play/';

const SEEN_KEY = (device) => `${device ?? 'deck'}/last-seen`;

export async function saveReport({ name, date, minutes, system, appid, device }) {
    const id = appid ? `steam-${appid}` : encodeURIComponent(name);
    await store().setJSON(`${REPORT_PREFIX}${id}|${date}${device ? `|${device}` : ''}`, { name, date, minutes, system, appid, device });
}

/** Remembers a device's last contact, so the page can tell "never reached the site" apart from a site-side problem. */
export const markDeckSeen = (game = null, device = null) => store().setJSON(SEEN_KEY(device), { at: new Date().toISOString(), game });

export const loadDeckSeen = async (device = null) => (await store().get(SEEN_KEY(device), { type: 'json' })) ?? null;

async function mergeReports(state, { now, names }) {
    const gained = [];
    const { blobs } = await store().list({ prefix: REPORT_PREFIX });
    for (const { key } of blobs) {
        const report = await store().get(key, { type: 'json' });
        if (report) {
            // Steam's name for its own games beats the Deck's install manifest.
            if (report.appid) report.name = names.get(report.appid) ?? report.name;
            const added = recordReportedPlay(state, report, { now });
            if (added > 0) gained.push({ name: report.appid ? report.name : cleanShortcutName(report.name), minutes: added });
        }
        await store().delete(key);
    }
    return gained;
}

export const saveCookie = (value) => store().set(COOKIE_KEY, value.trim().replace(/^_backloggd_session=/, ''));

export async function makeBackloggd() {
    const sessionCookie = (await store().get(COOKIE_KEY)) ?? process.env.BACKLOGGD_SESSION;
    return new BackloggdClient({
        sessionCookie,
        username: process.env.BACKLOGGD_USERNAME,
        password: process.env.BACKLOGGD_PASSWORD,
    });
}

/** One full cycle: read Steam (owned playtime + what is running now), record it, push it to Backloggd. */
export async function runSync({ now = new Date() } = {}) {
    const timeZone = process.env.SYNC_TIMEZONE || 'America/Toronto';
    const steam = { apiKey: process.env.STEAM_API_KEY, steamId: process.env.STEAM_ID };
    let state = forAccount(await loadState(), steam.steamId);

    let games, current;
    try {
        [games, current] = await Promise.all([getOwnedGames(steam), getCurrentGame(steam)]);
    } catch (err) {
        state.lastRun = now.toISOString();
        state.lastError = { at: now.toISOString(), message: String(err.message ?? err) };
        appendLog(state, { at: state.lastRun, error: state.lastError.message });
        await saveState(state);
        return { gained: [], pushed: [], error: state.lastError };
    }
    // Deck reports first: a Steam game the Deck counts is then left out of Steam's playtime.
    let reported = [];
    try {
        reported = await mergeReports(state, { now, names: new Map(games.map((g) => [g.appid, g.name])) });
    } catch (err) {
        appendLog(state, { at: now.toISOString(), error: `Rapports du Deck illisibles : ${err.message ?? err}` });
    }
    const recorded = recordPlaytime(state, games, { now, timeZone });
    const live = recordLiveGame(recorded.state, current, { now, timeZone });
    state = live.state;
    state.lastRun = now.toISOString();
    // Save before touching Backloggd, so the playtime is never counted twice.
    await saveState(state);

    const backloggd = await makeBackloggd();
    let pushed = [];
    let finished = [];
    try {
        pushed = await pushToBackloggd(state, backloggd);
        finished = await markFinishedGames(state, backloggd, { now, budgetMs: 5_000 });
        state.lastError = null;
    } catch (err) {
        state.lastError = { at: now.toISOString(), auth: err instanceof AuthError, message: String(err.message ?? err) };
    }
    const gained = [...recorded.gained, ...live.gained, ...reported];
    appendLog(state, { at: state.lastRun, gained, pushed, finished, error: state.lastError?.message });
    if (backloggd.sessionCookie) await saveCookie(backloggd.sessionCookie);
    await saveState(state);

    return { gained, pushed, error: state.lastError };
}
