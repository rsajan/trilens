// Script packs: move Pine scripts in and out of "My Scripts" as files, so a set of scripts can be
// backed up, moved to another browser or phone, or added in one go.
//
// Accepted files:
//  - a pack (.json): { "format": "trilens-pine-pack", "scripts": [{ "name": "...", "source": "..." }] }
//    or simply an array of { name, source };
//  - plain Pine source (.pine or .txt): one script per file, named after its indicator() title,
//    or after the file name if it has none.
// Importing a script whose name already exists replaces that script's source instead of adding a
// duplicate, so the same pack can be imported again after an update.

const FORMAT = 'trilens-pine-pack';
const MAX_SOURCE = 200_000; // characters per script: far beyond any real indicator, guards against junk files

const titleOf = (src) => { const m = /\b(?:indicator|study)\s*\(\s*(?:title\s*=\s*)?"([^"]+)"/.exec(src); return m ? m[1].trim() : null; };
const clean = (s) => String(s).replace(/\r\n?/g, '\n');

/**
 * @param {string} fileName @param {string} text
 * @returns {{ scripts: { name: string, source: string }[], skipped: string[] }}
 */
export function parsePack(fileName, text) {
  const skipped = [];
  const base = fileName.replace(/\.[^.]+$/, '');
  let data = null;
  if (/\.json$/i.test(fileName) || /^\s*[[{]/.test(text)) {
    try { data = JSON.parse(text); } catch { if (/\.json$/i.test(fileName)) return { scripts: [], skipped: [`${fileName}: not valid JSON`] }; }
  }
  if (data) {
    const list = Array.isArray(data) ? data : Array.isArray(data.scripts) ? data.scripts : null;
    if (!list) return { scripts: [], skipped: [`${fileName}: no "scripts" list`] };
    const scripts = [];
    list.forEach((s, i) => {
      if (!s || typeof s.source !== 'string' || !s.source.trim()) { skipped.push(`${fileName} #${i + 1}: no source`); return; }
      if (s.source.length > MAX_SOURCE) { skipped.push(`${fileName} #${i + 1}: too long`); return; }
      const name = (typeof s.name === 'string' && s.name.trim()) || titleOf(s.source) || `${base} ${i + 1}`;
      scripts.push({ name: name.slice(0, 120), source: clean(s.source) });
    });
    return { scripts, skipped };
  }
  if (!text.trim()) return { scripts: [], skipped: [`${fileName}: empty`] };
  if (text.length > MAX_SOURCE) return { scripts: [], skipped: [`${fileName}: too long`] };
  return { scripts: [{ name: (titleOf(text) || base).slice(0, 120), source: clean(text) }], skipped };
}

/** A pack of the given scripts, ready to save as a .json file. */
export function buildPack(scripts) {
  return JSON.stringify({ format: FORMAT, version: 1, exported: new Date().toISOString(), scripts: scripts.map(({ name, source }) => ({ name, source })) }, null, 2);
}
