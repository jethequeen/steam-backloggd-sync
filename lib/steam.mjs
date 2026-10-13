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
