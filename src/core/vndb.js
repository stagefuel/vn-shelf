'use strict';
// VNDB lookups for titles, cover art and game info (https://api.vndb.org/kana). No key needed for reads.

const API = 'https://api.vndb.org/kana/vn';
const SEARCH_FIELDS = 'id,title,alttitle,released,developers.name,image.url,image.sexual,image.dims';
const INFO_FIELDS = `${SEARCH_FIELDS},aliases,description,length,length_minutes,rating,votecount,languages,platforms,olang,`
  + 'tags.id,tags.name,tags.rating,tags.spoiler,tags.lie,tags.category';

// VNDB's length buckets (1 = very short … 5 = very long).
const LENGTHS = { 1: 'very-short', 2: 'short', 3: 'medium', 4: 'long', 5: 'very-long' };

function idFilter(q) {
  const m = /^(?:https?:\/\/vndb\.org\/)?(v\d+)$/i.exec(String(q || '').trim());
  return m ? m[1].toLowerCase() : null;
}

async function post(body, fetchImpl) {
  const res = await fetchImpl(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'VN-Shelf' },
    body: JSON.stringify(body),
  });
  if (res.status === 429) throw Object.assign(new Error('VNDB is rate-limiting requests; try again in a minute.'), { code: 'rate-limited' });
  if (!res.ok) throw new Error(`VNDB request failed (${res.status})`);
  return res.json();
}

function brief(v) {
  return {
    vndbId: v.id,
    title: v.title,
    titleAlt: v.alttitle || '',
    released: v.released || '',
    developer: (v.developers || []).map((d) => d.name).join(', '),
    image: v.image ? v.image.url : null,
    imageSexual: v.image ? v.image.sexual : 0,
  };
}

/** The info VN Shelf keeps in game.json (synced), trimmed to what the UI shows. */
function info(v) {
  const tags = (v.tags || [])
    .filter((t) => t.rating >= 1.2 && !t.lie)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 40)
    .map((t) => ({ id: t.id, name: t.name, rating: Math.round(t.rating * 10) / 10, spoiler: t.spoiler || 0, category: t.category }));
  return {
    id: v.id,
    description: v.description || '',
    released: v.released || '',
    length: LENGTHS[v.length] || null,
    lengthMinutes: v.length_minutes || null,
    rating: v.rating || null,
    votes: v.votecount || 0,
    languages: v.languages || [],
    platforms: v.platforms || [],
    originalLanguage: v.olang || null,
    aliases: v.aliases || [],
    tags,
    fetchedAt: new Date().toISOString(),
  };
}

async function search(query, { fetchImpl = fetch, limit = 15 } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const id = idFilter(q);
  const data = await post({
    filters: id ? ['id', '=', id] : ['search', '=', q],
    fields: SEARCH_FIELDS,
    results: limit,
    ...(id ? {} : { sort: 'searchrank' }),
  }, fetchImpl);
  return (data.results || []).map(brief);
}

/** Search and return the best match with full info in one request (used by bulk import). */
async function bestMatch(query, { fetchImpl = fetch } = {}) {
  const q = String(query || '').trim();
  if (!q) return null;
  const id = idFilter(q);
  const data = await post({
    filters: id ? ['id', '=', id] : ['search', '=', q],
    fields: INFO_FIELDS,
    results: 1,
    ...(id ? {} : { sort: 'searchrank' }),
  }, fetchImpl);
  const v = (data.results || [])[0];
  return v ? { ...brief(v), info: info(v) } : null;
}

/** Full info for one VN id. */
async function fetchInfo(vndbId, { fetchImpl = fetch } = {}) {
  const id = idFilter(vndbId);
  if (!id) throw new Error(`Not a VNDB id: ${vndbId}`);
  const data = await post({ filters: ['id', '=', id], fields: INFO_FIELDS, results: 1 }, fetchImpl);
  const v = (data.results || [])[0];
  if (!v) throw new Error(`VNDB has no entry ${id}`);
  return { ...brief(v), info: info(v) };
}

async function downloadImage(url, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': 'VN-Shelf' } });
  if (!res.ok) throw new Error(`Cover download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = (/\.(jpe?g|png|webp)(?:$|\?)/i.exec(url) || [, 'jpg'])[1].toLowerCase().replace('jpeg', 'jpg');
  return { buf, ext: `.${ext}` };
}

/**
 * Turn VNDB's description markup ([url=..]..[/url], [spoiler], [b], [i], [quote], [raw] …) into
 * plain segments the UI renders as text: [{ text, spoiler?, href? }]. Never produces HTML.
 */
function parseDescription(src) {
  const out = [];
  let spoiler = 0;
  let href = null;
  const re = /\[(\/?)(url|spoiler|b|i|u|s|quote|raw|code)(?:=([^\]]*))?\]/gi;
  let last = 0;
  let m;
  const push = (text) => {
    if (!text) return;
    const seg = { text };
    if (spoiler) seg.spoiler = true;
    if (href) seg.href = href;
    out.push(seg);
  };
  while ((m = re.exec(src || ''))) {
    push(src.slice(last, m.index));
    last = re.lastIndex;
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (tag === 'spoiler') spoiler = Math.max(0, spoiler + (closing ? -1 : 1));
    else if (tag === 'url') href = closing ? null : normaliseUrl(m[3]);
  }
  push((src || '').slice(last));
  return out;
}

function normaliseUrl(u) {
  if (!u) return null;
  if (/^\/[a-z]\d+/i.test(u)) return `https://vndb.org${u}`;
  return /^https?:\/\//i.test(u) ? u : null;
}

module.exports = { search, bestMatch, fetchInfo, downloadImage, parseDescription, info, LENGTHS };
