// tests/ui_static_guard.test.mjs — 前端静态守卫（捕捉「实现了但从未真正跑通」的低级错误）
//
// 由来：`collectBoard(editorVar)` 期望**编辑器实例**，但 `roomOpts()` 曾传字符串 id
// （`collectBoard('board-build-editor')`）→ 永远返回 null → 建房时画的棋盘形状从未被提交。
// 该 Bug 逃过了所有接口层测试（HTTP 层直接传 board 是正常的），只有真人点击才会发现。
// 本文件用静态扫描把它钉住，防止再次引入。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

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
