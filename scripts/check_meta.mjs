// scripts/check_meta.mjs — L0 静态合规
import fs from 'node:fs';
import path from 'node:path';
const dir = 'server/kernels';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort();
let bad = 0;
const ids = new Map();
for (const f of files) {
  const code = fs.readFileSync(path.join(dir, f), 'utf8');
  const m = code.match(/__meta\s*=\s*\{[\s\S]+?\}\s*;?\s*$/m);
  if (!m) { console.log('NO_META', f); bad++; continue; }
  const meta = m[0];
  const idMatch = meta.match(/id:\s*['"]([^'"]+)['"]/);
  if (!idMatch) { console.log('NO_ID', f); bad++; continue; }
  const id = idMatch[1];
  if (ids.has(id)) { console.log('DUP_ID', f, '<>', ids.get(id), '=', id); bad++; }
  ids.set(id, f);
  if (!/branch:\s*['"]/.test(meta)) { console.log('NO_BRANCH', f); bad++; }
  // banned tokens (loose: only banned at file level, since some kernels expose "evalF" param name)
  if (/\brequire\(/.test(code)) { console.log('REQUIRE', f); bad++; }
  if (/import\s+.*\bfs\b/.test(code)) { console.log('FS_IMPORT', f); bad++; }
  if (/\bprocess\b/.test(code)) { console.log('PROCESS', f); bad++; }
}
console.log('TOTAL_FILES', files.length, 'UNIQUE_IDS', ids.size, 'BAD', bad);
if (bad === 0) console.log('L0_OK');