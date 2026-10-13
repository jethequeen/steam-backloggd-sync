/**
 * EmuDeck / Steam ROM Manager system folders (.../roms/<folder>/) to Backloggd platform ids.
 * Backloggd's catalogue comes from IGDB, and these are IGDB's platform ids.
 */
const IGDB_PLATFORMS = {
    nes: 18, famicom: 18, fds: 51,
    snes: 19, sfc: 19, sufami: 19,
    n64: 4, n64dd: 416,
    gc: 21, ngc: 21, gamecube: 21,
    wii: 5, wiiu: 41, switch: 130,
    gb: 33, gbc: 22, gba: 24,
    nds: 20, n3ds: 37, '3ds': 37,
    virtualboy: 87,
    psx: 7, ps1: 7, ps2: 8, ps3: 9, psp: 38, psvita: 46,
    mastersystem: 64, sms: 64,
    genesis: 29, megadrive: 29, md: 29,
    segacd: 78, megacd: 78, sega32x: 30,
    gamegear: 35, saturn: 32, dreamcast: 23,
    arcade: 52, mame: 52, fbneo: 52, cps1: 52, cps2: 52, cps3: 52, naomi: 52, atomiswave: 52,
    neogeo: 80, ngp: 119, ngpc: 120,
    pcengine: 86, tg16: 86, pcenginecd: 150, tg16cd: 150,
    atari2600: 59, atari7800: 60, lynx: 61, atarilynx: 61, jaguar: 62, atarijaguar: 62,
    wonderswan: 57, wonderswancolor: 123,
    '3do': 50, xbox: 11, dos: 13, pc: 6,
};

/** The Backloggd platform id for a ROM folder, or null when unknown. */
export const platformFor = (system) => (system && IGDB_PLATFORMS[String(system).toLowerCase()]) || null;
