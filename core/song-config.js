// core/song-config.js

let cached = null;

export async function loadSongConfig() {
  if (cached) return cached;
  try {
    const conf = await fetch('./contents/rhythm/song-config.json').then(r => r.json());
    const activeId = localStorage.getItem('rg_song') || conf.activeTrack;
    const track = conf.tracks?.[activeId] || conf.tracks?.[conf.activeTrack] || null;
    cached = { raw: conf, activeId, track };
    return cached;
  } catch (_) {
    cached = { raw: null, activeId: null, track: null };
    return cached;
  }
}

