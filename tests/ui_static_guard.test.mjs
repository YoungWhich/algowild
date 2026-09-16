// tests/ui_static_guard.test.mjs — 前端静态守卫（捕捉「实现了但从未真正跑通」的低级错误）
//
// 由来：`collectBoard(editorVar)` 期望**编辑器实例**，但 `roomOpts()` 曾传字符串 id
// （`collectBoard('board-build-editor')`）→ 永远返回 null → 建房时画的棋盘形状从未被提交。
// 该 Bug 逃过了所有接口层测试（HTTP 层直接传 board 是正常的），只有真人点击才会发现。
// 本文件用静态扫描把它钉住，防止再次引入。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createGomokuView } from '../public/modes/gomoku.js';
import { createWeiqiView } from '../public/modes/weiqi.js';

const CLIENT = 'public/client.js';

function readClient() {
  return fs.readFileSync(CLIENT, 'utf8');
}

test('UG-01 collectBoard 只能用编辑器实例调用，不得传字符串 id', () => {
  const src = readClient();
  const calls = src.match(/collectBoard\s*\(([^)]*)\)/g) || [];
  assert.ok(calls.length > 0, '应存在 collectBoard 调用');
  const bad = calls.filter((c) => /collectBoard\s*\(\s*['"]/.test(c));
  assert.deepEqual(bad, [], `collectBoard 收到字符串字面量（应传编辑器实例）: ${bad.join(' | ')}`);
});

test('UG-02 建房/单人开局都要提交棋盘形状与回合制限制', () => {
  const src = readClient();
  // roomOpts 中必须有 board 与 goLimits 字段
  assert.ok(/board:\s*collectBoard\(boardBuildEditor\)/.test(src),
    'roomOpts 的 board 必须来自编辑器实例');
  assert.ok(/goLimits:\s*collectGoLimits\(\)/.test(src),
    'roomOpts / 单人开局 必须收集 goLimits');
  // 单人开局（quick-room）路径也要带 board 与 goLimits
  const q = src.slice(src.indexOf("$('quick-room')"));
  const qBlock = q.slice(0, q.indexOf('};', q.indexOf('api(')) + 2);
  assert.ok(/board:\s*collectBoard\(boardBuildEditor\)/.test(qBlock), 'quick-room 应提交 board');
  assert.ok(/goLimits:\s*collectGoLimits\(\)/.test(qBlock), 'quick-room 应提交 goLimits');
});

test('UG-03 倒计时环不得硬编码每手时限（应读服务端下发的 g.turnMs）', () => {
  const src = readClient();
  assert.ok(/const GO_TURN_MS = \(g\.turnMs && g\.turnMs > 0\) \? g\.turnMs : 30000;/.test(src),
    '倒计时环必须使用服务端下发的 turnMs（房主可配），不得写死 30000');
});

// ---- 遗留修复 #3：#胜利条件文案按模式（gomoku/weiqi 不再误用 rts 文案） ----

test('UG-04 client.js 胜利条件文案按模式：gomoku/weiqi 专属；rts/go 保持原样', () => {
  const src = readClient();
  // 模式感知的"显示名 / 说明"访问器
  assert.ok(/function victoryLineLabel\(/.test(src), '应有 victoryLineLabel(k, mode)');
  assert.ok(/function victoryLineDesc\(/.test(src), '应有 victoryLineDesc(k, mode)');
  // gomoku / weiqi 专属文案（替换 rts 的"占满地图 16 区…"）
  assert.ok(src.includes('五连即胜'), '应含 gomoku 文案（五连即胜）');
  assert.ok(src.includes('横 / 竖 / 斜连成 5 子（含 5 子以上）即胜；盘满无五连 → 平局'), '应含 gomoku 说明');
  assert.ok(src.includes('数子定胜负'), '应含 weiqi 文案（数子定胜负）');
  assert.ok(src.includes('中国规则数子（子数 + 围住空点）+ 贴目 7.5 定胜负（双方连续停手后数子）'), '应含 weiqi 说明');
  // rts / go 现有文案**不得**被改
  assert.ok(src.includes('占满地图 16 区且进入帝国时代 → 胜'), 'rts 领土说明应保持');
  assert.ok(src.includes('双方停手后数子（子数 + 归属空点），多者胜'), 'go 领土说明应保持');
  // 可用胜利线本身（仅 territory）不动
  assert.ok(/gomoku:\s*\['territory'\]/.test(src), 'gomoku 可用胜利线仍仅 territory');
  assert.ok(/weiqi:\s*\['territory'\]/.test(src), 'weiqi 可用胜利线仍仅 territory');
});

// ---- 遗留修复 #4：新模式键盘快捷键（VIEWS 表分派，不动 go/rts） ----

test('UG-05 client.js keydown 按 VIEWS[<id>].input.onKeyDown 分派', () => {
  const src = readClient();
  assert.ok(/VIEWS\[currentModeId\(\)\][\s\S]{0,160}input\.onKeyDown/.test(src),
    'keydown 应存在 VIEWS[...].input.onKeyDown 分派');
  // go/rts 键位分支仍在（未被改动/劫持）
  assert.ok(/if \(isGo\(\)\) \{/.test(src), 'go 专属键位分支应仍在');
  assert.ok(/if \(e\.key\.toLowerCase\(\) === 'f' && !state\._plantPressed\)/.test(src), 'rts 移动/落子键应仍在');
});

test('UG-06 gomoku 视图：R 键 = 认输（与 HUD 按钮同路径，发 gomoku.resign）', () => {
  const sent = [];
  const env = {
    state: { world: { go: { phase: 'play', turn: 1 } }, user: { id: 1 } },
    $: () => null, toast: () => {}, modal: () => {}, escapeHtml: (s) => String(s),
    sameId: (a, b) => String(a) === String(b),
    sendIntent: (i) => sent.push(i),
  };
  const v = createGomokuView(env);
  assert.equal(typeof v.input.onKeyDown, 'function', 'gomoku 应提供 input.onKeyDown');
  assert.equal(v.input.onKeyDown({ key: 'r' }), true, 'R 应被认领');
  assert.deepEqual(sent, [{ gomoku: { resign: true } }]);
  // 非认领键 → false（回落给通用处理，不劫持）
  assert.equal(v.input.onKeyDown({ key: 'f' }), false);
  assert.equal(v.input.onKeyDown({ key: 'Enter' }), false);
});

test('UG-07 weiqi 视图：P 键 = 停一手、R 键 = 认输（与各自 HUD 按钮同路径）', () => {
  const sent = [];
  const env = {
    state: { world: { go: { phase: 'play', turn: 1 } }, user: { id: 1 } },
    $: () => null, toast: () => {}, modal: () => {}, escapeHtml: (s) => String(s),
    sameId: (a, b) => String(a) === String(b),
    sendIntent: (i) => sent.push(i),
  };
  const v = createWeiqiView(env);
  assert.equal(typeof v.input.onKeyDown, 'function', 'weiqi 应提供 input.onKeyDown');
  assert.equal(v.input.onKeyDown({ key: 'p' }), true, 'P 应被认领（停一手）');
  assert.equal(v.input.onKeyDown({ key: 'r' }), true, 'R 应被认领（认输）');
  assert.deepEqual(sent, [{ weiqi: { pass: true } }, { weiqi: { resign: true } }]);
  assert.equal(v.input.onKeyDown({ key: 'x' }), false);
});

test('UG-08 gomoku/weiqi 键位不劫持：非本回合时 pass 不发意图；对局结束后 R/P 也不发', () => {
  // weiqi：非本回合 → P 认领但仅提示，不发意图
  const sent = [];
  const env = {
    state: { world: { go: { phase: 'play', turn: 2 } }, user: { id: 1 } },
    $: () => null, toast: () => {}, modal: () => {}, escapeHtml: (s) => String(s),
    sameId: (a, b) => String(a) === String(b),
    sendIntent: (i) => sent.push(i),
  };
  const v = createWeiqiView(env);
  assert.equal(v.input.onKeyDown({ key: 'p' }), true);
  assert.deepEqual(sent, [], '非本回合不得发 pass 意图');
  // 终局后：R 认领但不发意图
  env.state.world.go.phase = 'over';
  assert.equal(v.input.onKeyDown({ key: 'r' }), true);
  assert.deepEqual(sent, [], '终局后不得发认输意图');
});
