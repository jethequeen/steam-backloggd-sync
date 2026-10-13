import { getStore } from '@netlify/blobs';
import { getCurrentGame, getOwnedGames } from './steam.mjs';
import { AuthError, BackloggdClient } from './backloggd.mjs';
import { appendLog, emptyState, forAccount, pushToBackloggd, recordLiveGame, recordPlaytime } from './sync.mjs';

const STATE_KEY = 'state';
// Kept apart from the state so the status endpoint can never print it.
const COOKIE_KEY = 'backloggd-session';

export const store = () => getStore('steam-backloggd');

export async function loadState() {
    return { ...emptyState(), ...((await store().get(STATE_KEY, { type: 'json' })) ?? {}) };
}

export const saveState = (state) => store().setJSON(STATE_KEY, state);

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
    const recorded = recordPlaytime(state, games, { now, timeZone });
    const live = recordLiveGame(recorded.state, current, { now, timeZone });
    state = live.state;
    state.lastRun = now.toISOString();
    // Save before touching Backloggd, so the playtime is never counted twice.
    await saveState(state);

    const backloggd = await makeBackloggd();
    let pushed = [];
    try {
        pushed = await pushToBackloggd(state, backloggd);
        state.lastError = null;
    } catch (err) {
        state.lastError = { at: now.toISOString(), auth: err instanceof AuthError, message: String(err.message ?? err) };
    }
    const gained = [...recorded.gained, ...live.gained];
    appendLog(state, { at: state.lastRun, gained, pushed, error: state.lastError?.message });
    if (backloggd.sessionCookie) await saveCookie(backloggd.sessionCookie);
    await saveState(state);

    return { gained, pushed, error: state.lastError };
}
