#!/usr/bin/env node
// scripts/new-mode.mjs — 一键新增模式脚手架（"照骨架快速加模式"）。
//
// 用法：
//   node scripts/new-mode.mjs <id> <Label> [boardMax] [boardDefault]
// 例：
//   node scripts/new-mode.mjs checkers 跳棋 8 8
//   node scripts/new-mode.mjs xiangqi 中国象棋 9 9
//
// 生成/接线（幂等；不覆盖已存在文件）：
//   1) server/modes/<id>.js        （由 server/modes/_template.js 生成，替换 id/label/尺寸，并自注册）
//   2) public/modes/<id>.js        （由 public/modes/_template.js 生成，前端视图骨架）
//   3) server/modes/index.js       （末尾追加 `import './<id>.js';`）
//   4) public/modes/index.js       （MODES 追加一条）
//   5) public/index.html           （#world-mode 追加 <option value="<id>"><Label></option>）
//   6) tests/<id>.test.mjs         （测试骨架）+ package.json 的 test 脚本追加该文件
//
// 安全：目标文件若已存在 → 直接报错退出，绝不覆盖；插入现有文件用精确锚点，改完用
//       `node --check`（.js）与 `JSON.parse`（package.json）校验，任何一步失败即中止并提示。
//
// 本模块导出纯构建函数（buildServerFile / buildClientFile / buildTestFile / modeNames），
// 供单测直接生成片段并校验语法，而无需真的改动仓库（CLI 仅在作为主模块执行时运行）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const p = (...a) => path.join(ROOT, ...a);

/** id → { Pascal, lowerCamel, UPPER } 命名令牌（供模板替换）。 */
export function modeNames(id) {
  const segs = String(id).split(/[^a-z0-9]+/).filter(Boolean);
  const Pascal = segs.map((s) => s[0].toUpperCase() + s.slice(1)).join('');
  const lowerCamel = segs[0] + segs.slice(1).map((s) => s[0].toUpperCase() + s.slice(1)).join('');
  const UPPER = String(id).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return { Pascal, lowerCamel, UPPER };
}

/** 生成 server/modes/<id>.js 全文（由后端模板替换占位符）。 */
export function buildServerFile(id, label, boardMax, boardDefault) {
  const { Pascal, lowerCamel, UPPER } = modeNames(id);
  let s = fs.readFileSync(p('server', 'modes', '_template.js'), 'utf8');
  s = s.replace(/'<id>'/g, `'${id}'`).replace(/<id>/g, id);
  s = s.replace(/'<Label>'/g, `'${label}'`).replace(/<Label>/g, label);
  s = s.replace(/const TEMPLATE_SIZE = 8;/, `const TEMPLATE_SIZE = ${boardDefault};`);
  s = s.replace(/boardMax: TEMPLATE_SIZE,/, `boardMax: ${boardMax},`);
  s = s.replace('// __REGISTER__\n// registerMode(def);', "// 自注册：主干经由注册表驱动本模式。\nregisterMode(def);");
  s = s.replace(/TEMPLATE/g, UPPER).replace(/Template/g, Pascal).replace(/template/g, lowerCamel);
  return s;
}

/** 生成 public/modes/<id>.js 全文（由前端模板替换占位符）。 */
export function buildClientFile(id, label, boardMax, boardDefault) {
  void boardMax;
  const { Pascal, lowerCamel, UPPER } = modeNames(id);
  let s = fs.readFileSync(p('public', 'modes', '_template.js'), 'utf8');
  s = s.replace(/TEMPLATE_N = 8;/, `TEMPLATE_N = ${boardDefault};`);
  s = s.replace(/TEMPLATE/g, UPPER).replace(/Template/g, Pascal).replace(/template/g, lowerCamel);
  s = s.replace(/<id>/g, id);
  s = s.replace(/<Label>/g, label);
  s = s.replace(/'新模式'/, `'${label}'`);
  return s;
}

/** 生成 tests/<id>.test.mjs 全文。 */
export function buildTestFile(id, label, boardMax, boardDefault) {
  void boardDefault;
  const { lowerCamel, UPPER } = modeNames(id);
  return `// tests/${id}.test.mjs — ${label} 模式插件（脚手架生成的骨架；按实际规则补测）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World, loadKernels } from '../server/engine.js';
import ${lowerCamel}Def from '../server/modes/${id}.js';
import { getMode, boardMaxForMode, normalizeMode, listModes } from '../server/modes/index.js';

await loadKernels();

test('${UPPER}-01 注册表：${id} 已注册（id/驱动/上限/归一/清单）', () => {
  const def = getMode('${id}');
  assert.equal(def.id, '${id}');
  assert.equal(def.label, '${label}');
  assert.equal(def.tickDriver, 'interval');
  assert.equal(boardMaxForMode('${id}'), ${boardMax});
  assert.equal(normalizeMode('${id}'), '${id}');
  assert.equal(${lowerCamel}Def.id, '${id}');
  assert.ok(listModes().some((m) => m.id === '${id}'), 'listModes 应含 ${id}');
});

test('${UPPER}-02 routeIntent：越界 → oob；正常落子 → ok', () => {
  const w = new World('tpl_${id}', 1, 7, { mode: '${id}' });
  w._skipAIFill = true;
  w.addPlayer(1, 'P1');
  w.addPlayer(2, 'P2');
  const bad = ${lowerCamel}Def.routeIntent(w, 1, { ${lowerCamel}: { lx: -1, ly: 0 } }, []);
  assert.equal(bad.handled, true);
  assert.equal(bad.result.reason, 'oob');
  const good = ${lowerCamel}Def.routeIntent(w, 1, { ${lowerCamel}: { lx: 0, ly: 0 } }, []);
  assert.equal(good.handled, true);
  assert.equal(good.result.ok, true);
  assert.deepEqual(${lowerCamel}Def.routeIntent(w, 1, { move: { dx: 1, dy: 0 } }, []), { handled: true, silent: true });
});

test('${UPPER}-03 IR-3a：server/modes/${id}.js 不含 Math.random / Date.now', () => {
  const src = readFileSync('server/modes/${id}.js', 'utf8');
  assert.ok(!/Math\\.random\\s*\\(/.test(src), '不得含 Math.random()');
  assert.ok(!/Date\\.now\\s*\\(/.test(src), '不得含 Date.now()');
});
`;
}

// ---- CLI ----
function die(msg) { console.error('\n✖ ' + msg); process.exit(1); }
function ok(msg) { console.log('  ✓ ' + msg); }

function main() {
  const [, , rawId, rawLabel, rawMax, rawDefault] = process.argv;
  if (!rawId || !rawLabel) {
    die('用法：node scripts/new-mode.mjs <id> <Label> [boardMax] [boardDefault]\n  例：node scripts/new-mode.mjs checkers 跳棋 8 8');
  }
  const id = String(rawId).trim();
  const label = String(rawLabel).trim();
  if (!/^[a-z][a-z0-9_]*$/.test(id)) die(`id 非法："${id}"（须为小写字母开头的 [a-z0-9_]+）`);
  if (!label) die('Label 不能为空');
  const boardMax = Number.isFinite(Number(rawMax)) ? Math.floor(Number(rawMax)) : 32;
  const boardDefault = Number.isFinite(Number(rawDefault)) ? Math.floor(Number(rawDefault)) : boardMax;
  if (boardMax < 1 || boardMax > 100) die('boardMax 须在 1..100');
  if (boardDefault < 1 || boardDefault > boardMax) die('boardDefault 须在 1..boardMax');

  const targets = {
    server: p('server', 'modes', `${id}.js`),
    client: p('public', 'modes', `${id}.js`),
    test: p('tests', `${id}.test.mjs`),
  };
  for (const [k, f] of Object.entries(targets)) {
    if (fs.existsSync(f)) die(`目标文件已存在，拒绝覆盖：${f}（${k}）`);
  }
  const { Pascal } = modeNames(id);

  console.log(`\n新增模式：id=${id} label=${label} boardMax=${boardMax} boardDefault=${boardDefault}\n`);

  fs.writeFileSync(targets.server, buildServerFile(id, label, boardMax, boardDefault));
  ok(`server/modes/${id}.js`);
  fs.writeFileSync(targets.client, buildClientFile(id, label, boardMax, boardDefault));
  ok(`public/modes/${id}.js`);
  fs.writeFileSync(targets.test, buildTestFile(id, label, boardMax, boardDefault));
  ok(`tests/${id}.test.mjs`);

  // 3) server/modes/index.js：末尾追加 import
  {
    const f = p('server', 'modes', 'index.js');
    const text = fs.readFileSync(f, 'utf8');
    const marker = `import './${id}.js';`;
    if (text.includes(marker)) { ok('server/modes/index.js 已含该 import（跳过）'); }
    else {
      const lines = text.split('\n');
      let last = -1;
      for (let i = 0; i < lines.length; i++) if (/^import '\.\/.+\.js';$/.test(lines[i])) last = i;
      if (last < 0) die('server/modes/index.js 未找到 import 锚点');
      lines.splice(last + 1, 0, marker);
      fs.writeFileSync(f, lines.join('\n'));
      ok('server/modes/index.js ← ' + marker);
    }
  }

  // 4) public/modes/index.js：MODES 追加一条
  {
    const f = p('public', 'modes', 'index.js');
    let text = fs.readFileSync(f, 'utf8');
    if (text.includes(`  ${id}: {`)) { ok('public/modes/index.js 已含该模式（跳过）'); }
    else {
      const start = text.indexOf('export const MODES = {');
      if (start < 0) die('public/modes/index.js 未找到 MODES');
      const close = text.indexOf('\n};', start);
      if (close < 0) die('public/modes/index.js 未找到 MODES 结束锚点');
      const entry = `\n  ${id}: {\n    id: '${id}',\n    label: '${label}',\n    kind: '${id}',\n    tickDriver: 'interval',\n    boardMax: ${boardMax},\n    boardDefault: ${boardDefault},\n  },`;
      text = text.slice(0, close) + entry + text.slice(close);
      fs.writeFileSync(f, text);
      ok('public/modes/index.js ← MODES 追加 ' + id);
    }
  }

  // 5) public/index.html：#world-mode 追加 option
  {
    const f = p('public', 'index.html');
    let text = fs.readFileSync(f, 'utf8');
    if (text.includes(`value="${id}"`)) { ok('public/index.html 已含该 option（跳过）'); }
    else {
      const sel = text.indexOf('id="world-mode"');
      if (sel < 0) die('public/index.html 未找到 #world-mode');
      const close = text.indexOf('</select>', sel);
      if (close < 0) die('public/index.html 未找到 </select>');
      const opt = `          <option value="${id}">${label}</option>\n`;
      text = text.slice(0, close) + opt + text.slice(close);
      fs.writeFileSync(f, text);
      ok('public/index.html ← <option value="' + id + '">');
    }
  }

  // 6b) package.json：test 脚本追加测试文件
  {
    const f = p('package.json');
    let text = fs.readFileSync(f, 'utf8');
    const rel = `tests/${id}.test.mjs`;
    if (text.includes(rel)) { ok('package.json 的 test 脚本已含该文件（跳过）'); }
    else {
      const anchor = 'tests/ui_static_guard.test.mjs"';
      if (!text.includes(anchor)) die('package.json 未找到 test 脚本锚点（tests/ui_static_guard.test.mjs）');
      text = text.replace(anchor, `tests/ui_static_guard.test.mjs ${rel}"`);
      fs.writeFileSync(f, text);
      ok('package.json ← test 追加 ' + rel);
    }
    try { JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { die('package.json 校验失败：' + e.message); }
  }

  // 校验：node --check 所有改动的 .js
  const jsFiles = [targets.server, targets.client, targets.test, p('server', 'modes', 'index.js'), p('public', 'modes', 'index.js')];
  for (const f of jsFiles) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) die(`语法校验失败：${f}\n${r.stderr || ''}`);
  }
  ok('全部 .js 通过 node --check；package.json 通过 JSON.parse');

  console.log(`
✅ 已生成并接线。剩余**手工**步骤：
  1) 在 public/client.js 顶部 import 新视图并登记 VIEWS：
       import { create${Pascal}View } from './modes/${id}.js';
       const VIEWS = { …, ${id}: create${Pascal}View(VIEW_ENV) };
  2) 按需在 server/modes/${id}.js 里实现真实规则（当前为模板骨架：恒落"甲"色）。
  3) 按实际规则完善 tests/${id}.test.mjs。
  4) 运行权威套件验证：node --test --expose-gc tests/${id}.test.mjs …（见 package.json 的 test 脚本）
`);
}

// 仅当作为主模块直接执行时才跑 CLI（被 import 时只导出纯构建函数）。
const _self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === _self) main();
