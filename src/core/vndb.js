'use strict';
// VNDB lookups for titles and cover art (https://api.vndb.org/kana). No key needed for reads.

const API = 'https://api.vndb.org/kana/vn';
const FIELDS = 'id,title,alttitle,released,developers.name,image.url,image.sexual,image.dims';

async function search(query, { fetchImpl = fetch, limit = 15 } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const idMatch = /^(?:https?:\/\/vndb\.org\/)?(v\d+)$/i.exec(q);
  const body = {
    filters: idMatch ? ['id', '=', idMatch[1].toLowerCase()] : ['search', '=', q],
    fields: FIELDS,
    results: limit,
    ...(idMatch ? {} : { sort: 'searchrank' }),
  };
  const res = await fetchImpl(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'VN-Shelf/0.1' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`VNDB search failed (${res.status})`);
  const data = await res.json();
  return (data.results || []).map((v) => ({
    vndbId: v.id,
    title: v.title,
    titleAlt: v.alttitle || '',
    released: v.released || '',
    developer: (v.developers || []).map((d) => d.name).join(', '),
    image: v.image ? v.image.url : null,
    imageSexual: v.image ? v.image.sexual : 0,
  }));
}

async function downloadImage(url, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': 'VN-Shelf/0.1' } });
  if (!res.ok) throw new Error(`Cover download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = (/\.(jpe?g|png|webp)(?:$|\?)/i.exec(url) || [, 'jpg'])[1].toLowerCase().replace('jpeg', 'jpg');
  return { buf, ext: `.${ext}` };
}

module.exports = { search, downloadImage };
