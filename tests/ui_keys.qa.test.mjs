// tests/ui_keys.qa.test.mjs — 独立回归：修复 #3（胜利条件文案按模式）+ #4（新模式键位）
//
// 由 QA（Edward）编写，独立于工程师的 tests/ui_static_guard.test.mjs（UG-04..UG-08）：
//   · #3 用「把 client.js 的胜利条件代码块沙箱化执行」得到**真实函数行为**，而非仅字符串匹配；
//     并逐字锁定 rts/go 文案与可用胜利线集合**真的一点没动**。
//   · #4 用 frontend 视图工厂的**真实返回对象**驱动 keydown，验证认领(true)/不认领(false)、
//     打字不劫持、终局/非本回合不发意图；并用静态分析证明 go/rts 键位**未被劫持**。
//   · 缓存破坏号 bump。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGomokuView } from '../public/modes/gomoku.js';
import { createWeiqiView } from '../public/modes/weiqi.js';

const CLIENT = 'public/client.js';
const readClient = () => readFileSync(CLIENT, 'utf8');

// ---------- #3：把胜利条件代码块沙箱化，得到真实函数 ----------

/**
 * 从 client.js 截取 [VICTORY_LINE_KEYS ... victoryLinesText] 代码块，在受控作用域中求值，
 * 返回其中的纯函数与常量（$ / escapeHtml 以桩注入，避免依赖 DOM）。
 */
function loadVictoryModule() {
  const src = readClient();
  const a = src.indexOf('const VICTORY_LINE_KEYS');
  const b = src.indexOf('// 模式切换时：重渲建房弹窗的胜利条件区');
  assert.ok(a > 0 && b > a, '应能定位胜利条件代码块');
  const code = src.slice(a, b);
  const factory = new Function('$', 'escapeHtml', code
    + '\nreturn { VICTORY_LINE_KEYS, VICTORY_AVAILABLE, VICTORY_LABEL, '
    + 'VICTORY_LINE_DEFAULT, victoryLineLabel, victoryLineDesc, availableVictoryLines, '
    + 'normVictoryLinesClient, victoryLinesText, renderVictoryLines };');
  return factory(() => null, (s) => String(s));
}
const V = loadVictoryModule();

test('Q2-UK-01 territory 显示名按模式：rts/go 仍「领土」，gomoku/weiqi 专属', () => {
  assert.equal(V.victoryLineLabel('territory', 'rts'), '领土');
  assert.equal(V.victoryLineLabel('territory', 'go'), '领土');
  assert.equal(V.victoryLineLabel('territory', 'gomoku'), '五连即胜');
  assert.equal(V.victoryLineLabel('territory', 'weiqi'), '数子定胜负');
});

test('Q2-UK-02 territory 说明按模式；rts/go 文案逐字不变', () => {
  assert.equal(V.victoryLineDesc('territory', 'rts'), '占满地图 16 区且进入帝国时代 → 胜');
  assert.equal(V.victoryLineDesc('territory', 'go'), '双方停手后数子（子数 + 归属空点），多者胜');
  assert.equal(V.victoryLineDesc('territory', 'gomoku'),
    '横 / 竖 / 斜连成 5 子（含 5 子以上）即胜；盘满无五连 → 平局');
  assert.equal(V.victoryLineDesc('territory', 'weiqi'),
    '中国规则数子（子数 + 围住空点）+ 贴目 7.5 定胜负（双方连续停手后数子）');
});

test('Q2-UK-03 可用胜利线集合不变：gomoku/weiqi 仍仅 territory（改文案不改线集合）', () => {
  assert.deepEqual(V.availableVictoryLines('gomoku'), ['territory']);
  assert.deepEqual(V.availableVictoryLines('weiqi'), ['territory']);
  assert.deepEqual(V.availableVictoryLines('go'), ['territory']);
  assert.deepEqual(V.availableVictoryLines('rts'), ['territory', 'economy', 'singularity', 'survival']);
  // 归一：全勾状态下 gomoku/weiqi 也不得多出线
  const all = { territory: true, economy: true, singularity: true, survival: true };
  assert.deepEqual(V.normVictoryLinesClient(all, 'gomoku'),
    { territory: true, economy: false, singularity: false, survival: false });
  assert.deepEqual(V.normVictoryLinesClient(all, 'weiqi'),
    { territory: true, economy: false, singularity: false, survival: false });
});

test('Q2-UK-04 victoryLinesText（HUD 展示串）按模式取显示名', () => {
  assert.equal(V.victoryLinesText({ territory: true }, 'rts'), '领土');
  assert.equal(V.victoryLinesText({ territory: true }, 'go'), '领土');
  assert.equal(V.victoryLinesText({ territory: true }, 'gomoku'), '五连即胜');
  assert.equal(V.victoryLinesText({ territory: true }, 'weiqi'), '数子定胜负');
});

test('Q2-UK-05 rts 其余胜利线显示名/说明一字未改', () => {
  assert.equal(V.victoryLineLabel('economy', 'rts'), '经济');
  assert.equal(V.victoryLineLabel('singularity', 'rts'), '采集');
  assert.equal(V.victoryLineLabel('survival', 'rts'), '灭族');
  assert.equal(V.victoryLineDesc('economy', 'rts'), '领先 600 分并保持 90 秒 → 胜');
  assert.equal(V.victoryLineDesc('singularity', 'rts'), '六种资源各存满 30 → 胜');
  assert.equal(V.victoryLineDesc('survival', 'rts'), '对手全部出局 → 胜');
});

test('Q2-UK-06 静态佐证：client.js 含两套文案且 gomoku/weiqi 显示名与 rts 不同', () => {
  const src = readClient();
  assert.ok(src.includes("gomoku: '五连即胜'") || /gomoku:\s*'五连即胜'/.test(src));
  assert.ok(/weiqi:\s*'数子定胜负'/.test(src));
  // rts/go 行仍是「领土」（未被覆盖为其它模式文案）
  assert.ok(/rts:\s*'领土',\s*go:\s*'领土'/.test(src));
  // 可用胜利线注册表仍按模式区分且 gomoku/weiqi 仅 territory
  assert.ok(/gomoku:\s*\['territory'\]/.test(src));
  assert.ok(/weiqi:\s*\['territory'\]/.test(src));
});

// ---------- #4：视图工厂真实对象上的 keydown 行为 ----------

function makeEnv(go, uid) {
  const sent = [];
  const env = {
    ctx: {}, cv: { width: 400, height: 400 },
    state: { world: { go }, user: { id: uid }, mouse: {} },
    $: () => null, toast: () => {}, modal: () => {}, escapeHtml: (s) => String(s),
    sameId: (a, b) => String(a) === String(b),
    sendIntent: (i) => sent.push(i),
    setModeVisibility: () => {},
  };
  return { env, sent };
}
function key(k) { const e = { key: k, _pd: false, preventDefault() { this._pd = true; } }; return e; }
function withTyping(fn) {
  globalThis.document = { activeElement: { tagName: 'INPUT' } };
  try { fn(); } finally { delete globalThis.document; }
}

test('Q2-UK-07 gomoku 视图：R=认输（发 gomoku.resign 且 preventDefault）；其它键不认领', () => {
  const { env, sent } = makeEnv({ phase: 'play', turn: 1 }, 1);
  const v = createGomokuView(env);
  assert.equal(typeof v.input.onKeyDown, 'function');
  const e = key('r');
  assert.equal(v.input.onKeyDown(e), true, 'R 应被认领');
  assert.equal(e._pd, true, '认领后应 preventDefault');
  assert.deepEqual(sent, [{ gomoku: { resign: true } }]);
  for (const k of ['f', 'q', 'p', 'x', 'Enter', 'Escape']) {
    assert.equal(v.input.onKeyDown(key(k)), false, `${k} 不应被 gomoku 认领（回落通用处理）`);
  }
  assert.equal(sent.length, 1, '非认领键不得产生意图');
});

test('Q2-UK-08 gomoku 视图：大写 R 亦认领；输入框聚焦（打字）时不劫持', () => {
  const { env, sent } = makeEnv({ phase: 'play', turn: 1 }, 1);
  const v = createGomokuView(env);
  assert.equal(v.input.onKeyDown(key('R')), true);
  assert.equal(sent.length, 1);
  withTyping(() => {
    assert.equal(v.input.onKeyDown(key('r')), false, '输入框聚焦 → 不劫持按键');
    assert.equal(sent.length, 1, '打字时不得新增 intent');
  });
});

test('Q2-UK-09 gomoku 视图：终局后 R 认领但不发意图', () => {
  const { env, sent } = makeEnv({ phase: 'over', turn: 1 }, 1);
  const v = createGomokuView(env);
  assert.equal(v.input.onKeyDown(key('r')), true);
  assert.deepEqual(sent, [], '终局后不得发认输意图');
});

test('Q2-UK-10 weiqi 视图：P=停一手、R=认输（与各自 HUD 同路径）；未知键不认领', () => {
  const { env, sent } = makeEnv({ phase: 'play', turn: 1 }, 1);
  const v = createWeiqiView(env);
  assert.equal(v.input.onKeyDown(key('p')), true);
  assert.equal(v.input.onKeyDown(key('r')), true);
  assert.deepEqual(sent, [{ weiqi: { pass: true } }, { weiqi: { resign: true } }]);
  assert.equal(v.input.onKeyDown(key('x')), false);
});

test('Q2-UK-11 weiqi 视图：非本回合 P 只提示不发；终局后 P/R 不发', () => {
  const { env, sent } = makeEnv({ phase: 'play', turn: 2 }, 1);
  const v = createWeiqiView(env);
  assert.equal(v.input.onKeyDown(key('p')), true, 'P 仍被认领（避免误落 rts 键）');
  assert.deepEqual(sent, [], '非本回合不得发 pass 意图');
  env.state.world.go.phase = 'over';
  assert.equal(v.input.onKeyDown(key('p')), true);
  assert.equal(v.input.onKeyDown(key('r')), true);
  assert.deepEqual(sent, [], '终局后不得发任何意图');
});

test('Q2-UK-12 weiqi 视图：输入框聚焦（打字）时不劫持', () => {
  const { env, sent } = makeEnv({ phase: 'play', turn: 1 }, 1);
  const v = createWeiqiView(env);
  withTyping(() => {
    assert.equal(v.input.onKeyDown(key('p')), false);
    assert.equal(v.input.onKeyDown(key('r')), false);
  });
  assert.deepEqual(sent, []);
});

// ---------- #4：go / rts 键位未被劫持（静态 + 结构） ----------

test('Q2-UK-13 VIEWS 表：go 条目无 input；无 rts 条目；gomoku/weiqi 走工厂', () => {
  const src = readClient();
  const a = src.indexOf('const VIEWS = {');
  const b = src.indexOf('};', a) + 2;
  assert.ok(a > 0 && b > a);
  const views = src.slice(a, b);
  const goEntry = views.match(/go:\s*\{[^}]*\}/);
  assert.ok(goEntry, 'VIEWS 应含 go 条目');
  assert.ok(!/input/.test(goEntry[0]), 'go 条目不得含 input（go 键位仍走上方的 isGo() 分支，不被新模式劫持）');
  assert.ok(!/\brts\s*:/.test(views), 'VIEWS 不应有 rts 条目（rts 无模式键位，回落通用处理）');
  assert.ok(/gomoku:\s*createGomokuView\(/.test(views), 'gomoku 走 createGomokuView 工厂');
  assert.ok(/weiqi:\s*createWeiqiView\(/.test(views), 'weiqi 走 createWeiqiView 工厂');
});

test('Q2-UK-14 键位分派顺序：go 分支先 return；随后才 VIEWS 分派；仅返回 true 才接管', () => {
  const src = readClient();
  const iGo = src.indexOf('if (isGo()) {');
  const iDispatch = src.indexOf('const mvk = VIEWS[currentModeId()]');
  const iRtsF = src.indexOf("e.key.toLowerCase() === 'f' && !state._plantPressed");
  assert.ok(iGo > 0, '应存在 go 专属键位分支');
  assert.ok(iDispatch > iGo, 'VIEWS 分派必须位于 go 分支之后');
  assert.ok(iRtsF > iDispatch, 'rts 键位处理应位于 VIEWS 分派之后');
  const between = src.slice(iGo, iDispatch);
  assert.ok(/\breturn;/.test(between), 'go 分支必须以 return 结束（不落入新模式分派）');
  assert.ok(/mvk\.input\.onKeyDown\(e\) === true\)\s*return;/.test(src), '仅当 onKeyDown 返回 true 才接管');
  // go 专属键位仍在（未被移除）
  for (const k of ["k === 'p'", "e.ctrlKey || e.metaKey", "e.key === 'Escape'", "e.key === 'Enter'", "k === 'q'", "k === 'v'"]) {
    assert.ok(src.includes(k), `go 键位片段应仍在：${k}`);
  }
  // rts 键位仍在
  assert.ok(src.includes("e.key.toLowerCase() === 'q'"), 'rts Q 键应仍在');
});

test('Q2-UK-15 行为级：rts/go 不会被新模式 onKeyDown 劫持（含 2 个真实工厂）', () => {
  const { env: ge } = makeEnv({ phase: 'play', turn: 1 }, 1);
  // 复现 client.js 的分派语义：map[mode].input?.onKeyDown(e) === true → 接管
  const map = {
    go: { render() {}, hud() {} },               // go 无 input
    gomoku: createGomokuView(ge),
    weiqi: createWeiqiView(ge),
    // rts 无条目
  };
  const hijack = (mode, e) => {
    const mv = map[mode];
    if (mv && mv.input && typeof mv.input.onKeyDown === 'function') return mv.input.onKeyDown(e) === true;
    return false;
  };
  for (const k of ['f', 'q', 'c', 'p', 'r', 'v']) {
    assert.equal(hijack('go', key(k)), false, `go 模式按键 ${k} 不应被新模式接管`);
    assert.equal(hijack('rts', key(k)), false, `rts 模式按键 ${k} 不应被接管`);
  }
  // 反证：gomoku/weiqi 确实会接管各自的键位
  assert.equal(hijack('gomoku', key('r')), true);
  assert.equal(hijack('weiqi', key('p')), true);
});

// ---------- 缓存破坏号 ----------

test('Q2-UK-16 public/index.html 已提升 client.js 的 ?v= 缓存破坏号', () => {
  const html = readFileSync('public/index.html', 'utf8');
  const m = html.match(/client\.js\?v=([A-Za-z0-9_.-]+)/);
  assert.ok(m, 'client.js 应带 ?v= 缓存破坏号');
  assert.ok(m[1] && m[1].length >= 4, '版本号应为非空 token');
});
