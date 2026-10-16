'use strict';
// Search matching for the library, suggestions and the archive. Each word of the search must match:
//   - a number matches that whole number (1 finds "Vol. 1", not 11 or 2010)
//   - a word in letters matches the start of a word ("toki" finds "Sakura no Toki", "k" finds "Kanon"
//     but not every title with a k in it)
//   - Japanese with kanji, or two or more kana, matches anywhere (no spaces between Japanese words)
//   - one kana matches the start of a name or word
// When one name holds every word, they must come in the order typed ("girls 1" isn't "1 girls");
// words found in different fields (a title and a tag, say) match in any order.
(function (root) {
  const KANJI = /[㐀-鿿豈-﫿]/;
  const KANA = /^[぀-ヿㇰ-ㇿｦ-ﾟ]+$/;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const norm = (s) => String(s || '').normalize('NFKC').toLowerCase();

  /** A regexp for one search word. */
  function wordRe(w) {
    if (/^\d+$/.test(w)) return new RegExp(`(?<!\\d)${esc(w)}(?!\\d)`);
    if (KANJI.test(w) || (KANA.test(w) && w.length >= 2)) return new RegExp(esc(w));
    // Start of the text or of a word (after a space or punctuation, or where letters meet digits/Japanese).
    return new RegExp(`(?:^|[^\\p{L}\\p{N}]|(?<=[^\\p{Script=Latin}])(?=\\p{Script=Latin}))${esc(w)}`, 'u');
  }

  function tokens(q) { return norm(q).trim().split(/\s+/).filter(Boolean); }

  /** Do the words match `fields` (strings)? */
  function matches(fields, q) {
    const ws = tokens(q);
    if (!ws.length) return true;
    const res = ws.map(wordRe);
    const texts = fields.filter(Boolean).map(norm);
    let sawAllOutOfOrder = false;
    for (const t of texts) {
      if (!res.every((r) => r.test(t))) continue;
      let at = 0;
      let ordered = true;
      for (const r of res) {
        const m = new RegExp(r.source, r.flags.includes('g') ? r.flags : `${r.flags}g`);
        m.lastIndex = at;
        const hit = m.exec(t);
        if (!hit) { ordered = false; break; }
        at = hit.index + hit[0].length;
      }
      if (ordered) return true;
      sawAllOutOfOrder = true;
    }
    if (sawAllOutOfOrder || ws.length === 1) return false;
    return res.every((r) => texts.some((t) => r.test(t)));
  }

  const api = { matches, wordRe, tokens };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.vnsSearch = api;
}(typeof window !== 'undefined' ? window : globalThis));
