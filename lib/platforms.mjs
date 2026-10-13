/**
 * EmuDeck / Steam ROM Manager system folders (.../roms/<folder>/) to Backloggd platforms:
 * the slugs Backloggd lists a game under (to pick the right game entry) and the IGDB
 * platform id (Backloggd's catalogue comes from IGDB) set as the log's played platform.
 */
const SYSTEMS = {
    nes: [18, 'nes', 'famicom'], famicom: [18, 'famicom', 'nes'], fds: [51, 'fds'],
    snes: [19, 'snes', 'sfam'], sfc: [19, 'sfam', 'snes'],
    n64: [4, 'n64'],
    gc: [21, 'ngc'], ngc: [21, 'ngc'], gamecube: [21, 'ngc'],
    wii: [5, 'wii'], wiiu: [41, 'wiiu'], switch: [130, 'switch'],
    gb: [33, 'gb'], gbc: [22, 'gbc'], gba: [24, 'gba'],
    nds: [20, 'nds'], n3ds: [37, '3ds', 'new-3ds'], '3ds': [37, '3ds', 'new-3ds'],
    virtualboy: [87, 'virtualboy'],
    psx: [7, 'ps'], ps1: [7, 'ps'], ps2: [8, 'ps2'], ps3: [9, 'ps3'], psp: [38, 'psp'], psvita: [46, 'psvita'],
    mastersystem: [64, 'sms'], sms: [64, 'sms'],
    genesis: [29, 'genesis-slash-megadrive'], megadrive: [29, 'genesis-slash-megadrive'], md: [29, 'genesis-slash-megadrive'],
    segacd: [78, 'sega-cd'], megacd: [78, 'sega-cd'], sega32x: [30, 'sega32'],
    gamegear: [35, 'gamegear'], saturn: [32, 'saturn'], dreamcast: [23, 'dc'],
    arcade: [52, 'arcade'], mame: [52, 'arcade'], fbneo: [52, 'arcade'], naomi: [52, 'arcade'], atomiswave: [52, 'arcade'],
    cps1: [52, 'arcade'], cps2: [52, 'arcade'], cps3: [52, 'arcade'],
    neogeo: [80, 'neogeoaes', 'neogeomvs'], neogeocd: [136, 'neo-geo-cd'], ngp: [119, 'neo-geo-pocket'], ngpc: [120, 'neo-geo-pocket-color'],
    pcengine: [86, 'turbografx16--1'], tg16: [86, 'turbografx16--1'],
    pcenginecd: [150, 'turbografx-16-slash-pc-engine-cd'], tg16cd: [150, 'turbografx-16-slash-pc-engine-cd'],
    atari2600: [59, 'atari2600'], atari7800: [60, 'atari7800'],
    lynx: [61, 'lynx'], atarilynx: [61, 'lynx'], jaguar: [62, 'jaguar'], atarijaguar: [62, 'jaguar'],
    wonderswan: [57, 'wonderswan'], wonderswancolor: [123, 'wonderswan-color'],
    '3do': [50, '3do'], xbox: [11, 'xbox'], dos: [13, 'dos'],
    // Steam games: Backloggd files them under Windows PC.
    pc: [6, 'win'],
};

const lookup = (system) => (system && SYSTEMS[String(system).toLowerCase()]) || null;

/** The IGDB platform id for a ROM folder, or null when unknown. */
export const platformFor = (system) => lookup(system)?.[0] ?? null;

/** Backloggd platform slugs a game released on this system is listed under; [] when unknown. */
export const platformSlugsFor = (system) => lookup(system)?.slice(1) ?? [];
