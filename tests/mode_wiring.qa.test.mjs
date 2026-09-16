// tests/mode_wiring.qa.test.mjs — 增量 v2 **独立** QA 套件（QA Edward 编写）
//
// 独立复核：前端模式接线 / 地图编辑器对全模式生效 / 分形模板与脚手架 / IR-3a / 隔离性。
// 与工程师 tests/mode_wiring.test.mjs 使用**不同的**断言与构造；脚手架"真实落盘"部分放在
// 独立的 QA 运行器里（避免并行测试文件互相改写注册表），本文件只做**非破坏性**检查。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import express from 'express';
import { World, loadKernels } from '../server/engine.js';
import { createRouter } from '../server/routes.js';
import { signToken } from '../server/auth.js';
import { initDB, usersRepo } from '../server/db/index.js';
import { buildServerFile, buildClientFile, buildTestFile, modeNames } from '../scripts/new-mode.mjs';

await initDB();
await loadKernels();

const ROOT = process.cwd();
const rd = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sha = (rel) => createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');
function stripComments(src) { return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' '); }

// ---------- A. 前端模式接线（静态） ----------

test('QWA-01 client.js 无"模式解析→rts"硬编码（独立正则，覆盖 task 点名的三类）', () => {
  const src = rd('public/client.js');
  assert.ok(!/===\s*'go'\s*\?\s*'go'\s*:\s*'rts'/.test(src), "残留 === 'go' ? 'go' : 'rts'");
  assert.ok(!/===\s*'go'\s*\?\s*'rts'\s*:\s*'go'/.test(src), "残留 === 'go' ? 'rts' : 'go'");
  assert.ok(!/\$\('world-mode'\)\s*\)?\s*\.?\s*value[\s\S]{0,40}===\s*'go'/.test(src), "残留 ($('world-mode').value) === 'go'");
  // roomOpts 的 mode 字段必须来自注册表归一
  const i = src.indexOf('function roomOpts()');
  assert.ok(i > 0, '应存在 roomOpts');
  const body = src.slice(i, i + 700);
  assert.ok(/_modeNormalize\(\$\('world-mode'\)/.test(body), 'roomOpts 应对下拉值调用 _modeNormalize');
  assert.ok(/\bmode,\s*\n/.test(body) || /\bmode\s*:/.test(body), 'roomOpts 应把归一后的 mode 作为 mode 字段提交');
  // 顶部确实 import 了归一访问器
  assert.ok(/normalizeMode as _modeNormalize/.test(src));
  assert.ok(/boardDefaultForMode as _modeBoardDefault/.test(src));
});

test('QWA-02 前端注册表（真 ESM import）归一 / 上限 / 默认 / 标签 / 清单', async () => {
  const mod = await import('../public/modes/index.js');
  const { MODES, normalizeMode, boardMaxForMode, boardDefaultForMode, getMode, isIntervalMode } = mod;
  assert.equal(normalizeMode('gomoku'), 'gomoku');
  assert.equal(normalizeMode('weiqi'), 'weiqi');
  assert.equal(normalizeMode('bogus'), 'rts');
  assert.equal(normalizeMode(''), 'rts');
  assert.equal(boardMaxForMode('gomoku'), 15);
  assert.equal(boardMaxForMode('weiqi'), 19);
  assert.equal(boardMaxForMode('bogus'), 100);          // 未知 → 宽松 100
  assert.equal(boardDefaultForMode('gomoku'), 15);
  assert.equal(boardDefaultForMode('weiqi'), 19);
  assert.equal(boardDefaultForMode('go'), 32);
  assert.equal(boardDefaultForMode('rts'), 32);
  assert.equal(boardDefaultForMode('bogus'), 32);       // 未知 → 32
  assert.equal(getMode('gomoku').label, '五子棋');
  assert.equal(getMode('weiqi').label, '标准围棋');
  assert.equal(isIntervalMode('gomoku'), true);
  assert.equal(isIntervalMode('weiqi'), true);
  assert.equal(isIntervalMode('rts'), false);
  // 与 server 注册表上限一致（前后端对齐）
  const srv = await import('../server/modes/index.js');
  for (const id of ['rts', 'go', 'gomoku', 'weiqi']) {
    assert.equal(boardMaxForMode(id), srv.boardMaxForMode(id), `${id} 前后端 boardMax 应一致`);
  }
  assert.deepEqual(Object.keys(MODES).sort(), ['go', 'gomoku', 'rts', 'weiqi']);
});

// ---------- A. 端到端 HTTP：建房 / 建世界的模式贯通 ----------

async function callApi(app, method, p, body, token) {
  const http = await import('node:http');
  return new Promise((resolve, reject) => {
    const server = app.listen(0);
    server.on('listening', () => {
      const port = server.address().port;
      const data = body ? JSON.stringify(body) : '';
      const req = http.request({
        method, hostname: '127.0.0.1', port, path: p,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          server.close();
          let parsed = null;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { parsed = { raw: 'x' }; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (data) req.write(data);
      req.end();
    });
  });
}
let seq = 0;
function mkUser(prefix) {
  const name = prefix + '_' + Date.now() + '_' + (seq++);
  usersRepo.create(name, name + '@t', 'h');
  const u = usersRepo.byUsername(name);
  return { id: u.id, token: signToken({ id: u.id, username: u.username }) };
}

test('QWA-03 HTTP：POST /api/rooms 与 /rooms/:code/world 建出 gomoku/weiqi（非 rts）；未知模式归一且不 5xx', async () => {
  const app = express(); app.use(express.json()); app.use('/api', createRouter());
  const host = mkUser('qwa_host');
  for (const mode of ['gomoku', 'weiqi']) {
    const r = await callApi(app, 'POST', '/api/rooms', { name: mode + 'QA房', maxPlayers: 2, mode }, host.token);
    assert.equal(r.status, 200, mode + ' 建房不应 5xx');
    assert.equal(r.body.code, 0);
    assert.equal(r.body.data.mode, mode, `建房 mode 应为 ${mode}，实为 ${r.body.data.mode}`);
    const code = r.body.data.code;
    const w = await callApi(app, 'POST', `/api/rooms/${code}/world`, { mode }, host.token);
    assert.equal(w.status, 200);
    assert.equal(w.body.code, 0);
    assert.equal(w.body.data.mode, mode, `建世界 mode 应为 ${mode}`);
    assert.ok(w.body.data.worldId);
  }
  const bad = await callApi(app, 'POST', '/api/rooms', { name: 'QA未知', maxPlayers: 2, mode: 'zzz_不存在' }, host.token);
  assert.ok(bad.status < 500, '未知模式不得 5xx');
  assert.ok(bad.body.data.mode == null || bad.body.data.mode === 'rts', `未知应归一 rts/null，实为 ${bad.body.data.mode}`);
});

// ---------- B. 地图编辑器对所有模式生效 ----------

// 4×4 形状：'.'=形状外(0) '#'=可落子(1) 'x'=虚空(2)；墙=(1,1)x(2,1).(1,2).(2,2).
const SHAPE_4 = '####/#x.#/#..#/####';
const WALLS_4 = [[1, 1], [2, 1], [1, 2], [2, 2]];
function shapedWorld(mode, seed = 3) {
  const w = new World(`qa_shaped_${mode}_${seed}`, 1, seed, { mode, board: { w: 4, h: 4, shape: SHAPE_4 } });
  w._skipAIFill = true;
  return w;
}

test('QWA-04 分形棋盘：gomoku 墙格拒落(reason=wall)且棋盘不变；可落格成功；尺寸取 max(w,h)', () => {
  const w = shapedWorld('gomoku');
  assert.equal(w.board.w, 4);
  assert.ok(w._bmp, '应编译出位图 _bmp');
  w.addPlayer(1, 'B'); w.addPlayer(2, 'W');
  const g = w._gomokuInit();
  assert.equal(g.size, 4, '容器尺寸应取 max(cfg.w,cfg.h)=4');
  for (const [x, y] of WALLS_4) {
    assert.equal(g.board[y * 4 + x], 99, `(${x},${y}) 应标记为墙(99)`);
  }
  const before = Array.from(g.board);
  for (const [x, y] of WALLS_4) {
    const r = w.applyGomokuIntent(1, { lx: x, ly: y }, []);
    assert.equal(r.ok, false, `墙格 (${x},${y}) 应被拒`);
    assert.equal(r.reason, 'wall');
  }
  assert.deepEqual(Array.from(g.board), before, '被拒后棋盘不得改变');
  assert.equal(g.moveNo, 0);
  // 可落格
  assert.equal(w.applyGomokuIntent(1, { lx: 0, ly: 0 }, []).ok, true);
  assert.equal(g.board[0], 1);
});

test('QWA-05 分形棋盘：weiqi 墙格拒落(reason=wall)且棋盘不变；可落格成功；形状化后仍无演化', () => {
  const w = shapedWorld('weiqi');
  w.addPlayer(1, 'B'); w.addPlayer(2, 'W');
  const g = w._weiqiInit();
  assert.equal(g.size, 4);
  for (const [x, y] of WALLS_4) assert.equal(g.board[y * 4 + x], 99, `(${x},${y}) 应标记为墙(99)`);
  const before = Array.from(g.board);
  for (const [x, y] of WALLS_4) {
    const r = w.applyWeiqiIntent(1, { lx: x, ly: y }, []);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'wall');
  }
  assert.deepEqual(Array.from(g.board), before, '被拒后棋盘不得改变');
  assert.equal(w.applyWeiqiIntent(1, { lx: 0, ly: 0 }, []).ok, true);
  // 形状化后**无演化**再钉一次
  const snap = Array.from(g.board);
  const stonesBefore = snap.filter((v) => v === 1 || v === 2).length;
  for (let i = 0; i < 5; i++) w._weiqiTick([]);
  assert.deepEqual(Array.from(g.board), snap, '形状化后 _weiqiTick 不得改变棋盘');
  const step = w._mode.intervalStep || w._mode.tick;
  for (let i = 0; i < 3; i++) step(w, []);
  assert.deepEqual(Array.from(g.board), snap, '形状化后主干 interval 步进也不得改变棋盘');
  assert.equal(Array.from(g.board).filter((v) => v === 1 || v === 2).length, stonesBefore);
});

test('QWA-06 默认回归：board=null 时 gomoku 15×15 / weiqi 19×19，无墙、标准行为', () => {
  const gw = new World('qa_rect_gomoku', 1, 1, { mode: 'gomoku' }); gw._skipAIFill = true;
  gw.addPlayer(1, 'B');
  const gg = gw._gomokuInit();
  assert.equal(gg.size, 15);
  assert.equal(gg.board.length, 225);
  assert.equal(Array.from(gg.board).some((v) => v === 3), false, '无形状 → 不得有墙');
  const ww = new World('qa_rect_weiqi', 1, 1, { mode: 'weiqi' }); ww._skipAIFill = true;
  ww.addPlayer(1, 'B');
  const wg = ww._weiqiInit();
  assert.equal(wg.size, 19);
  assert.equal(wg.board.length, 361);
  assert.equal(Array.from(wg.board).some((v) => v === 3), false);
  // 标准 15 连不误判墙：直接在边缘落子应当成功
  assert.equal(gw.applyGomokuIntent(1, { lx: 14, ly: 14 }, []).ok, true);
});

test('QWA-07 抗回归：带形状的 go 世界仍可构建/快照（go 形状处理不受影响）', () => {
  const w = new World('qa_shaped_go', 1, 9, { mode: 'go', board: { w: 4, h: 4, shape: SHAPE_4 } });
  w._skipAIFill = true;
  w.addPlayer(1, 'P');
  assert.doesNotThrow(() => w.snapshot());
  const s = w.snapshot();
  assert.equal(s.mode, 'go');
  assert.ok(s.go && typeof s.go === 'object');
});

// ---------- C. 模板 inert + 脚手架纯函数（非破坏） ----------

test('QWA-08 后端模板 inert：registerMode 保持注释；import 模板不新增注册', async () => {
  const tpl = rd('server/modes/_template.js');
  assert.ok(/^\s*\/\/\s*registerMode\(def\);/m.test(tpl), '模板 registerMode 必须为注释（inert）');
  const reg = await import('../server/modes/index.js');
  const before = reg.listModes().map((m) => m.id).sort();
  await import('../server/modes/_template.js');
  const after = reg.listModes().map((m) => m.id).sort();
  assert.deepEqual(after, before, 'import 模板不得改变注册表');
});

test('QWA-09 脚手架纯函数：占位符全替换、命名正确、注册启用、node --check 通过', () => {
  const id = 'qa_demo', label = 'QA演示', max = 8, def = 6;
  const sv = buildServerFile(id, label, max, def);
  const cl = buildClientFile(id, label, max, def);
  const ts = buildTestFile(id, label, max, def);
  assert.deepEqual(modeNames('qa_demo'), { Pascal: 'QaDemo', lowerCamel: 'qaDemo', UPPER: 'QA_DEMO' });
  for (const [n, s] of [['server', sv], ['client', cl], ['test', ts]]) {
    assert.ok(!s.includes('<id>') && !s.includes('<Label>'), `${n} 仍有占位符`);
  }
  assert.ok(!sv.includes('__REGISTER__') && !sv.includes('// registerMode(def);'),
    '生成的 server 插件不应残留 inert 注册标记');
  assert.ok(sv.includes("id: 'qa_demo'"));
  assert.ok(sv.includes("label: 'QA演示'"));
  assert.ok(sv.includes('const QA_DEMO_SIZE = 6;'), '默认尺寸应替换为 boardDefault');
  assert.ok(sv.includes('boardMax: 8,'), 'boardMax 应替换');
  assert.ok(/^\s*registerMode\(def\);/m.test(sv), '生成的 server 插件应**启用**自注册');
  assert.ok(cl.includes('createQaDemoView'), '前端工厂函数应重命名');
  assert.ok(ts.includes("import qaDemoDef from '../server/modes/qa_demo.js'"));
  // 语法合法（写入临时目录后 node --check）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-newmode-'));
  try {
    for (const [fn, code] of [['s.mjs', sv], ['c.mjs', cl], ['t.mjs', ts]]) {
      const fp = path.join(dir, fn);
      fs.writeFileSync(fp, code);
      const r = spawnSync(process.execPath, ['--check', fp], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${fn} 语法失败：${r.stderr}`);
    }
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
});

test('QWA-10 脚手架拒绝覆盖已存在 id（且**不改动任何仓库文件**）', () => {
  const watch = ['server/modes/index.js', 'public/modes/index.js', 'public/index.html', 'package.json',
    'server/modes/gomoku.js', 'public/modes/gomoku.js', 'tests/gomoku.test.mjs'];
  const before = watch.map((f) => [f, sha(f)]);
  const r = spawnSync(process.execPath, ['scripts/new-mode.mjs', 'gomoku', '五子棋'], { encoding: 'utf8', cwd: ROOT });
  assert.notEqual(r.status, 0, '对已存在 id 应非零退出');
  assert.ok(/拒绝覆盖|已存在/.test(r.stdout + r.stderr), '应打印拒绝覆盖提示');
  const after = watch.map((f) => [f, sha(f)]);
  assert.deepEqual(after, before, '拒绝覆盖时不得改动任何被监视文件');
});

// ---------- D. IR-3a 确定性 ----------

test('QWA-11 IR-3a：gomoku/weiqi 与两个 _template.js 去注释后无 Math.random / Date.now', () => {
  const files = ['server/modes/gomoku.js', 'server/modes/weiqi.js', 'server/modes/_template.js', 'public/modes/_template.js'];
  for (const f of files) {
    const code = stripComments(rd(f));
    assert.ok(!/Math\s*\.\s*random/.test(code), `${f} 代码含 Math.random`);
    assert.ok(!/Date\s*\.\s*now/.test(code), `${f} 代码含 Date.now`);
  }
});
