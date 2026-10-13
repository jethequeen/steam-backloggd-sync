import { getStore } from '@netlify/blobs';
import { getOwnedGames } from './steam.mjs';
import { AuthError, BackloggdClient } from './backloggd.mjs';
import { emptyState, pushToBackloggd, recordPlaytime } from './sync.mjs';

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

/** One full cycle: read Steam, record what was played, push it to Backloggd. */
export async function runSync({ now = new Date() } = {}) {
    const timeZone = process.env.SYNC_TIMEZONE || 'America/Toronto';
    let state = await loadState();

    const games = await getOwnedGames({ apiKey: process.env.STEAM_API_KEY, steamId: process.env.STEAM_ID });
    const recorded = recordPlaytime(state, games, { now, timeZone });
    state = recorded.state;
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
    if (backloggd.sessionCookie) await saveCookie(backloggd.sessionCookie);
    await saveState(state);

    return { gained: recorded.gained, pushed, error: state.lastError };
}
