'use strict';
// VNDB lookups for titles, cover art and game info (https://api.vndb.org/kana). No key needed for reads.

// VNS_VNDB_API points every VNDB request at a stand-in server (tests).
const apiUrl = (endpoint = 'vn') => `${process.env.VNS_VNDB_API || 'https://api.vndb.org/kana'}/${endpoint}`;
const SEARCH_FIELDS = 'id,title,alttitle,released,developers.name,image.url,image.sexual,image.dims';
const INFO_FIELDS = `${SEARCH_FIELDS},aliases,description,length,length_minutes,rating,votecount,languages,platforms,olang,`
  + 'tags.id,tags.name,tags.rating,tags.spoiler,tags.lie,tags.category';

// VNDB's length buckets (1 = very short … 5 = very long).
const LENGTHS = { 1: 'very-short', 2: 'short', 3: 'medium', 4: 'long', 5: 'very-long' };

function idFilter(q) {
  const m = /^(?:https?:\/\/vndb\.org\/)?(v\d+)$/i.exec(String(q || '').trim());
  return m ? m[1].toLowerCase() : null;
}

async function post(body, fetchImpl, endpoint = 'vn') {
  const res = await fetchImpl(apiUrl(endpoint), {
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

/** Title and cover for many VN ids at once (100 per request). */
async function fetchBriefs(ids, { fetchImpl = fetch } = {}) {
  const want = [...new Set(ids.map(idFilter).filter(Boolean))];
  const out = [];
  for (let i = 0; i < want.length; i += 100) {
    const chunk = want.slice(i, i + 100);
    const data = await post({ filters: chunk.length === 1 ? ['id', '=', chunk[0]] : ['or', ...chunk.map((v) => ['id', '=', v])], fields: SEARCH_FIELDS, results: 100 }, fetchImpl);
    out.push(...(data.results || []).map(brief));
  }
  return out;
}

/** A VN's Windows releases, newest first, for pinning an upload to one. */
async function fetchReleases(vndbId, { fetchImpl = fetch } = {}) {
  const id = idFilter(vndbId);
  if (!id) return [];
  const data = await post({ filters: ['vn', '=', ['id', '=', id]], fields: 'title, alttitle, released, languages.lang, platforms, patch, official, vns.id, vns.rtype', results: 100, sort: 'released', reverse: true }, fetchImpl, 'release');
  return (data.results || []).filter((r) => !r.patch && (!r.platforms || !r.platforms.length || r.platforms.includes('win')))
    .map((r) => ({
      id: r.id, title: r.alttitle || r.title, titleEn: r.title, released: r.released || '',
      languages: (r.languages || []).map((l) => l.lang), official: r.official !== false,
      type: ((r.vns || []).find((v) => v.id === id) || {}).rtype || 'complete',
    }));
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

// ---------------------------------------------------------------- extras for a game's page
// Screenshots, related VNs, staff and brands (one request), characters (one more), and everything a
// person or brand worked on. Shown on the game page; cached on this PC only, never in game.json.

const EXTRA_FIELDS = 'relations.id,relations.relation,relations.relation_official,relations.title,relations.alttitle,'
  + 'relations.released,relations.image.url,'
  + 'screenshots.url,screenshots.dims,screenshots.thumbnail,screenshots.thumbnail_dims,screenshots.release.languages.lang,'
  + 'staff.id,staff.name,staff.original,staff.role,staff.note,developers.id,developers.name,developers.original';

/**
 * The screenshots to show: the Japanese release's if there are any, else the English release's,
 * else none (other languages' screenshots are never shown).
 */
function pickScreenshots(shots) {
  const langs = (s) => ((s.release && s.release.languages) || []).map((l) => l.lang);
  for (const lang of ['ja', 'en']) {
    const set = (shots || []).filter((s) => langs(s).includes(lang));
    if (set.length) {
      return set.map((s) => ({ url: s.url, dims: s.dims || null, thumb: s.thumbnail || s.url, thumbDims: s.thumbnail_dims || null, lang }));
    }
  }
  return [];
}

// Relation codes, in the order they're shown.
const RELATIONS = ['preq', 'seq', 'fan', 'side', 'par', 'ser', 'set', 'alt', 'char', 'orig'];

async function fetchExtras(vndbId, { fetchImpl = fetch } = {}) {
  const id = idFilter(vndbId);
  if (!id) throw new Error(`Not a VNDB id: ${vndbId}`);
  const data = await post({ filters: ['id', '=', id], fields: EXTRA_FIELDS, results: 1 }, fetchImpl);
  const v = (data.results || [])[0];
  if (!v) throw new Error(`VNDB has no entry ${id}`);
  // One entry per person, with all their roles (and notes) on this VN.
  const people = new Map();
  for (const st of v.staff || []) {
    const p = people.get(st.id) || { id: st.id, name: st.name, original: st.original || '', roles: [], notes: [] };
    if (!p.roles.includes(st.role)) p.roles.push(st.role);
    if (st.note && !p.notes.includes(st.note)) p.notes.push(st.note);
    people.set(st.id, p);
  }
  return {
    screenshots: pickScreenshots(v.screenshots),
    relations: (v.relations || [])
      .map((r) => ({ vndbId: r.id, relation: r.relation, official: r.relation_official !== false, title: r.title, titleAlt: r.alttitle || '', released: r.released || '', image: r.image ? r.image.url : null }))
      .sort((a, b) => (RELATIONS.indexOf(a.relation) - RELATIONS.indexOf(b.relation)) || String(a.released).localeCompare(String(b.released))),
    staff: [...people.values()],
    developers: (v.developers || []).map((d) => ({ id: d.id, name: d.name, original: d.original || '' })),
    fetchedAt: new Date().toISOString(),
  };
}

const ROLE_ORDER = ['main', 'primary', 'side', 'appears'];

/** The characters of a VN, protagonist and main heroines first. `spoiler` > 0 means knowing about them is a spoiler. */
async function fetchCharacters(vndbId, { fetchImpl = fetch, maxPages = 5 } = {}) {
  const id = idFilter(vndbId);
  if (!id) throw new Error(`Not a VNDB id: ${vndbId}`);
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await post({
      filters: ['vn', '=', ['id', '=', id]],
      fields: 'name,original,image.url,description,blood_type,height,weight,bust,waist,hips,birthday,age,sex,vns.id,vns.role,vns.spoiler,traits.id,traits.name,traits.group_name,traits.spoiler',
      results: 100, page,
    }, fetchImpl, 'character');
    for (const c of data.results || []) {
      const mine = (c.vns || []).filter((x) => x.id === id);
      if (!mine.length) continue;
      const role = ROLE_ORDER.find((r) => mine.some((x) => x.role === r)) || 'appears';
      out.push({
        id: c.id, name: c.name, original: c.original || '', image: c.image ? c.image.url : null,
        description: c.description || '', role, spoiler: Math.min(...mine.map((x) => x.spoiler || 0)),
        sex: Array.isArray(c.sex) ? c.sex[0] : null, age: c.age || null, birthday: c.birthday || null,
        bloodType: c.blood_type || null, height: c.height || null,
        traits: (c.traits || []).map((x) => ({ id: x.id, name: x.name, group: x.group_name || '', spoiler: x.spoiler || 0 })),
      });
    }
    if (!data.more) break;
  }
  return out.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.spoiler - b.spoiler);
}

/** Everything a person (s123) or brand (p123) worked on, newest first, with the person's roles. */
async function fetchWorks(personOrBrand, { fetchImpl = fetch, maxPages = 5 } = {}) {
  const m = /^(?:https?:\/\/vndb\.org\/)?([sp]\d+)$/i.exec(String(personOrBrand || '').trim());
  if (!m) throw new Error(`Not a VNDB staff or producer id: ${personOrBrand}`);
  const id = m[1].toLowerCase();
  const staff = id.startsWith('s');
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await post({
      filters: [staff ? 'staff' : 'developer', '=', ['id', '=', id]],
      fields: `title,alttitle,released,image.url,rating${staff ? ',staff.id,staff.role' : ''}`,
      sort: 'released', reverse: true, results: 100, page,
    }, fetchImpl);
    for (const v of data.results || []) {
      out.push({
        vndbId: v.id, title: v.title, titleAlt: v.alttitle || '', released: v.released || '', image: v.image ? v.image.url : null,
        rating: v.rating || null,
        roles: staff ? [...new Set((v.staff || []).filter((x) => x.id === id).map((x) => x.role))] : [],
      });
    }
    if (!data.more) break;
  }
  return out;
}

/** The name of a person or brand (for the page heading). */
async function fetchName(personOrBrand, { fetchImpl = fetch } = {}) {
  const id = String(personOrBrand).toLowerCase();
  const data = await post({ filters: ['id', '=', id], fields: 'name,original', results: 1 }, fetchImpl, id.startsWith('s') ? 'staff' : 'producer');
  const r = (data.results || [])[0];
  return r ? { name: r.name, original: r.original || '' } : null;
}

/**
 * The engines VNDB lists for a VN's releases, most likely first: official Windows releases in
 * Japanese, then other official Windows releases, then any Windows release (fan ports last).
 */
async function fetchEngines(vndbId, { fetchImpl = fetch } = {}) {
  const id = idFilter(vndbId);
  if (!id) throw new Error(`Not a VNDB id: ${vndbId}`);
  const data = await post({ filters: ['vn', '=', ['id', '=', id]], fields: 'engine,official,platforms,languages.lang', results: 100 }, fetchImpl, 'release');
  const rank = (r) => {
    if (!(r.platforms || []).includes('win')) return 9;
    if (!r.official) return 3;
    return (r.languages || []).some((l) => l.lang === 'ja') ? 0 : 1;
  };
  const counts = new Map();
  for (const r of data.results || []) {
    const name = String(r.engine || '').trim();
    if (!name || rank(r) === 9) continue;
    const k = counts.get(name) || { name, rank: 9, n: 0 };
    k.rank = Math.min(k.rank, rank(r));
    k.n++;
    counts.set(name, k);
  }
  return [...counts.values()].sort((a, b) => a.rank - b.rank || b.n - a.n).map((k) => k.name);
}

/**
 * Covers to choose from for a VN: its main cover, then every release's front cover and digital
 * cover (Japanese releases first), without repeats. [{ url, thumb, sexual, type, lang }]
 */
async function fetchCovers(vndbId, { fetchImpl = fetch } = {}) {
  const id = idFilter(vndbId);
  if (!id) throw new Error(`Not a VNDB id: ${vndbId}`);
  const [vn, rel] = await Promise.all([
    post({ filters: ['id', '=', id], fields: 'image.url,image.thumbnail,image.sexual', results: 1 }, fetchImpl),
    post({ filters: ['vn', '=', ['id', '=', id]], fields: 'images.url,images.thumbnail,images.type,images.sexual,languages.lang', results: 100 }, fetchImpl, 'release'),
  ]);
  const out = [];
  const seen = new Set();
  const add = (img, type, lang) => {
    if (!img || !img.url || seen.has(img.url)) return;
    seen.add(img.url);
    out.push({ url: img.url, thumb: img.thumbnail || img.url, sexual: img.sexual || 0, type, lang });
  };
  const v = (vn.results || [])[0];
  if (v && v.image) add(v.image, 'main', '');
  const releases = (rel.results || []).map((r) => ({ ...r, ja: (r.languages || []).some((l) => l.lang === 'ja') }))
    .sort((a, b) => Number(b.ja) - Number(a.ja));
  for (const r of releases) {
    for (const img of r.images || []) {
      if (img.type === 'pkgfront' || img.type === 'dig') add(img, img.type, r.ja ? 'ja' : ((r.languages || [])[0] || {}).lang || '');
    }
  }
  return out;
}

module.exports = {
  search, bestMatch, fetchInfo, fetchBriefs, fetchReleases, downloadImage, parseDescription, info, LENGTHS,
  fetchExtras, fetchCharacters, fetchWorks, fetchName, fetchEngines, fetchCovers, pickScreenshots, RELATIONS,
};
