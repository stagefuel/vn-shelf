'use strict';
// IGDB search, as a fallback for games VNDB doesn't have. Only used when you set a game's identity
// yourself (Find…), never automatically. IGDB needs a Twitch app secret that can't ship in a public
// app, so requests go through VN Shelf's proxy (igdb.yumiharigakuen.com), which holds it.

// VNS_IGDB_API points at a stand-in server (tests).
const apiUrl = (endpoint) => `${process.env.VNS_IGDB_API || 'https://igdb.yumiharigakuen.com/igdb/v4'}/${endpoint}`;
const COVER_HOST = 'https://images.igdb.com/';
const coverUrl = (imageId, size = 't_cover_big') => (imageId ? `${COVER_HOST}igdb/image/upload/${size}/${imageId}.jpg` : null);

const quote = (s) => `"${String(s).replace(/["\\]/g, ' ').replace(/[\r\n]+/g, ' ').trim().slice(0, 200)}"`;

function brief(g) {
  const devs = (g.involved_companies || []).filter((c) => c.developer && c.company).map((c) => c.company.name);
  const d = g.first_release_date ? new Date(g.first_release_date * 1000).toISOString().slice(0, 10) : '';
  const ja = (g.alternative_names || []).map((a) => a.name).find((n) => /[\u3040-\u30ff\u4e00-\u9fff]/.test(n)) || '';
  return {
    igdbId: g.id,
    title: g.name,
    titleAlt: ja,
    released: d,
    developer: devs.join(', '),
    image: coverUrl(g.cover && g.cover.image_id),
    summary: g.summary || '',
    url: g.url || `https://www.igdb.com/games/${g.slug || g.id}`,
    platforms: (g.platforms || []).map((p) => p.abbreviation || p.name).filter(Boolean),
  };
}

async function search(query, { fetchImpl = fetch, limit = 15 } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const body = `search ${quote(q)}; fields name, slug, url, summary, first_release_date, cover.image_id, alternative_names.name, `
    + `involved_companies.developer, involved_companies.company.name, platforms.abbreviation, platforms.name; limit ${limit};`;
  const res = await fetchImpl(apiUrl('games'), { method: 'POST', headers: { 'Content-Type': 'text/plain', 'User-Agent': 'VN-Shelf' }, body });
  if (res.status === 429) throw Object.assign(new Error('IGDB is busy; try again in a minute.'), { code: 'rate-limited' });
  if (!res.ok) throw new Error(`IGDB search failed (${res.status})`);
  return (await res.json()).map(brief);
}

module.exports = { search, brief, coverUrl, COVER_HOST };
