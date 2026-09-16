// tests/mode_wiring.test.mjs — 前端模式接线 + 地图编辑器尺寸 + 分形模板/脚手架 的静态与运行时守卫。
//
// 由来：`roomOpts()` 等处曾把模式写死为 `value === 'go' ? 'go' : 'rts'`，
// 导致选了五子棋/围棋也会被按 rts 建房（面板、棋盘上限、胜利线全错）。本文件钉住这些接缝。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildServerFile, buildClientFile, buildTestFile, modeNames } from '../scripts/new-mode.mjs';
import express from 'express';
import { createRouter } from '../server/routes.js';
import { signToken } from '../server/auth.js';
import { initDB, usersRepo } from '../server/db/index.js';
import { loadKernels } from '../server/engine.js';

await initDB();
await loadKernels();

const CLIENT = 'public/client.js';
const FE_REG = 'public/modes/index.js';

// ---- HTTP 集成：建房 / 建世界 模式贯通（复刻 client roomOpts 提交的字段）----
function setupApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createRouter());
  return app;
}
async function call(app, method, path, body, token) {
  const http = await import('node:http');
  return new Promise((resolve, reject) => {
    const server = app.listen(0);
    server.on('listening', () => {
      const port = server.address().port;
      const data = body ? JSON.stringify(body) : '';
      const req = http.request({
        method, hostname: '127.0.0.1', port, path,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          server.close();
          const txt = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try { parsed = JSON.parse(txt); } catch { parsed = { raw: txt }; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (data) req.write(data);
      req.end();
    });
  });
}
let _seq = 0;
function newUser(prefix = 'mw') {
  const name = prefix + '_' + Date.now() + '_' + (_seq++);
  usersRepo.create(name, name + '@t', 'fakehash');
  const u = usersRepo.byUsername(name);
  return { id: u.id, username: u.username, token: signToken({ id: u.id, username: u.username }) };
}


test('MW-01 client.js 不再残留 `=== \'go\' ? \'go\' : \'rts\'` 模式硬编码', () => {
  const src = fs.readFileSync(CLIENT, 'utf8');
  assert.ok(!/===\s*'go'\s*\?\s*'go'\s*:\s*'rts'/.test(src), 'client.js 仍有 `=== \'go\' ? \'go\' : \'rts\'`');
  assert.ok(!/===\s*'go'\s*\?\s*'rts'\s*:\s*'go'/.test(src), 'client.js 仍有 `=== \'go\' ? \'rts\' : \'go\'`');
  // 也不应再有 `($('world-mode').value) === 'go'` 这类下拉值硬编码
  assert.ok(!/\$\('world-mode'\)[^;]*===\s*'go'/.test(src), 'client.js 仍有 world-mode === \'go\' 硬编码');
});

test('MW-02 模式解析统一走注册表归一（_modeNormalize）', () => {
  const src = fs.readFileSync(CLIENT, 'utf8');
  // 顶部 import 了注册表归一/默认尺寸/标签访问器
  assert.ok(/import \{[^}]*normalizeMode as _modeNormalize[^}]*\} from '\.\/modes\/index\.js'/.test(src),
    'client.js 应 import normalizeMode as _modeNormalize');
  assert.ok(/boardDefaultForMode as _modeBoardDefault/.test(src), 'client.js 应 import boardDefaultForMode');
  assert.ok(/getMode as _modeGet/.test(src), 'client.js 应 import getMode');
  // roomOpts / collectGoLimits 用归一
  const roomOpts = src.slice(src.indexOf('function roomOpts()'), src.indexOf('function roomOpts()') + 900);
  assert.ok(/_modeNormalize\(\$\('world-mode'\)/.test(roomOpts), 'roomOpts 的 mode 应走 _modeNormalize');
});

test('MW-03 前端注册表 MODES 的 boardMax/boardDefault 与预期一致', async () => {
  const mod = await import('../' + FE_REG);
  const { MODES, boardMaxForMode, boardDefaultForMode, normalizeMode, getMode } = mod;
  assert.equal(MODES.rts.boardMax, 32);   assert.equal(MODES.rts.boardDefault, 32);
  assert.equal(MODES.go.boardMax, 100);   assert.equal(MODES.go.boardDefault, 32);
  assert.equal(MODES.gomoku.boardMax, 15); assert.equal(MODES.gomoku.boardDefault, 15);
  assert.equal(MODES.weiqi.boardMax, 19);  assert.equal(MODES.weiqi.boardDefault, 19);
  assert.equal(boardMaxForMode('gomoku'), 15);
  assert.equal(boardDefaultForMode('gomoku'), 15);
  assert.equal(boardDefaultForMode('weiqi'), 19);
  assert.equal(boardDefaultForMode('不存在'), 32);   // 未知 → 32
  assert.equal(normalizeMode('gomoku'), 'gomoku');
  assert.equal(normalizeMode('不存在'), 'rts');
  assert.equal(getMode('gomoku').label, '五子棋');
  assert.equal(getMode('weiqi').label, '标准围棋');
});

test('MW-04 分形模板文件存在，且后端模板 inert（不自注册）', async () => {
  assert.ok(fs.existsSync('server/modes/_template.js'), 'server/modes/_template.js 应存在');
  assert.ok(fs.existsSync('public/modes/_template.js'), 'public/modes/_template.js 应存在');
  assert.ok(fs.existsSync('scripts/new-mode.mjs'), 'scripts/new-mode.mjs 应存在');
  // 后端模板源码里注册行是**注释**（inert）
  const tpl = fs.readFileSync('server/modes/_template.js', 'utf8');
  assert.ok(/^\s*\/\/ registerMode\(def\);/m.test(tpl), '模板的 registerMode 必须保持注释（inert）');
  // 导入模板不应注册任何模式
  const reg = await import('../server/modes/index.js');
  const before = reg.listModes().map((m) => m.id);
  await import('../server/modes/_template.js');
  const after = reg.listModes().map((m) => m.id);
  assert.deepEqual(after, before, '导入 _template.js 不得向注册表新增模式');
});

test('MW-05 脚手架生成的片段语法合法（node --check），且命名/占位符替换正确', () => {
  const id = 'demo_tmp', label = '临时演示', boardMax = 15, boardDefault = 15;
  const sv = buildServerFile(id, label, boardMax, boardDefault);
  const cl = buildClientFile(id, label, boardMax, boardDefault);
  const ts = buildTestFile(id, label, boardMax, boardDefault);

  // 占位符应全部被替换
  for (const [name, s] of [['server', sv], ['client', cl], ['test', ts]]) {
    assert.ok(!s.includes('<id>'), `${name} 片段仍含 <id> 占位符`);
    assert.ok(!s.includes('<Label>'), `${name} 片段仍含 <Label> 占位符`);
  }
  // 命名令牌
  assert.deepEqual(modeNames('demo_tmp'), { Pascal: 'DemoTmp', lowerCamel: 'demoTmp', UPPER: 'DEMO_TMP' });
  assert.ok(sv.includes("id: 'demo_tmp'"), 'server 片段应含 id');
  assert.ok(sv.includes("label: '临时演示'"), 'server 片段应含 label');
  assert.ok(sv.includes('const DEMO_TMP_SIZE = 15;'), 'server 片段应替换默认尺寸');
  assert.ok(sv.includes('boardMax: 15,'), 'server 片段应替换 boardMax');
  assert.ok(/^\s*registerMode\(def\);/m.test(sv), 'server 片段应**启用**注册（去掉注释）');
  assert.ok(cl.includes('createDemoTmpView'), 'client 片段应重命名工厂函数');
  assert.ok(ts.includes("import demoTmpDef from '../server/modes/demo_tmp.js'"), 'test 片段应 import 新插件');

  // 语法合法：写入临时目录（.mjs 强制 ESM 解析）后 node --check
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newmode-'));
  try {
    const files = [['server.mjs', sv], ['client.mjs', cl], ['test.mjs', ts]];
    for (const [fn, code] of files) {
      const fp = path.join(dir, fn);
      fs.writeFileSync(fp, code);
      const r = spawnSync(process.execPath, ['--check', fp], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${fn} 语法校验失败：${r.stderr || ''}`);
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('MW-06 HTTP：POST /api/rooms 与 /rooms/:code/world 能建出 gomoku / weiqi 模式', async () => {
  const app = setupApp();
  const host = newUser('mw_host');
  for (const mode of ['gomoku', 'weiqi']) {
    const r = await call(app, 'POST', '/api/rooms', { name: mode + '房', maxPlayers: 2, mode }, host.token);
    assert.equal(r.status, 200);
    assert.equal(r.body.code, 0, `建房应成功（${mode}）`);
    assert.equal(r.body.data.mode, mode, `POST /api/rooms 的 mode 应为 ${mode}`);
    const code = r.body.data.code;
    const w = await call(app, 'POST', `/api/rooms/${code}/world`, { mode }, host.token);
    assert.equal(w.status, 200);
    assert.equal(w.body.code, 0, `建世界应成功（${mode}）`);
    assert.equal(w.body.data.mode, mode, `POST /rooms/${code}/world 的 mode 应为 ${mode}`);
    assert.ok(w.body.data.worldId, '应返回 worldId');
  }
  // 未知模式 → 归一为 rts / null（不 5xx，且不会变成某个具体新模式）
  const bad = await call(app, 'POST', '/api/rooms', { name: '未知', maxPlayers: 2, mode: '不存在的模式' }, host.token);
  assert.equal(bad.body.code, 0);
  assert.ok(bad.body.data.mode == null || bad.body.data.mode === 'rts',
    `未知模式应归一为 rts/null，实际 ${bad.body.data.mode}`);
});
