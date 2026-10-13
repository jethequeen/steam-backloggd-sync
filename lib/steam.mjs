const OWNED_GAMES_URL = 'https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/';

/**
 * Every owned game with its lifetime playtime in minutes.
 * Requires the profile's "Game details" privacy setting to be public.
 */
export async function getOwnedGames({ apiKey, steamId, fetchImpl = fetch }) {
    const url = new URL(OWNED_GAMES_URL);
    url.search = new URLSearchParams({
        key: apiKey,
        steamid: steamId,
        include_appinfo: '1',
        include_played_free_games: '1',
        format: 'json',
    }).toString();

    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`Steam GetOwnedGames HTTP ${res.status}`);
    const data = await res.json();
    const games = data?.response?.games;
    // An empty response object (no `games` key) is what a private profile returns.
    if (!Array.isArray(games)) {
        throw new Error('Steam returned no games: is the profile\'s "Game details" set to public?');
    }
    return games.map((g) => ({
        appid: g.appid,
        name: g.name ?? `App ${g.appid}`,
        playtime: g.playtime_forever ?? 0,
        lastPlayed: g.rtime_last_played ?? 0,
    }));
}

const SUMMARIES_URL = 'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/';

/**
 * What the profile shows as "In-Game" right now, or null.
 * For a non-Steam shortcut (Steam ROM Manager, emulators), `name` is the shortcut's
 * title and `gameId` is a shortcut id that never matches an owned appid.
 */
export async function getCurrentGame({ apiKey, steamId, fetchImpl = fetch }) {
    const url = new URL(SUMMARIES_URL);
    url.search = new URLSearchParams({ key: apiKey, steamids: steamId, format: 'json' }).toString();

    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`Steam GetPlayerSummaries HTTP ${res.status}`);
    const player = (await res.json())?.response?.players?.[0];
    if (!player?.gameextrainfo) return null;
    return { gameId: player.gameid ?? null, name: player.gameextrainfo };
}
