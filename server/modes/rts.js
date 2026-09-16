// server/modes/rts.js — 默认模式（实时生存对战）。
//
// rts 是"主干内置"模式：其模拟逻辑（9 阶段 tick）、玩家加入、意图入队、快照都由 WorldEngine 本体实现，
// 因此本插件只声明元数据，不提供任何钩子方法。这样新增其它模式时，rts 主干逻辑保持稳定。
import { registerMode } from './index.js';

const rts = {
  id: 'rts',
  label: '实时生存对战',
  tickDriver: 'realtime', // 20 TPS 主循环驱动
  boardMax: 32, // 生命层恒 32×32（棋盘只做遮罩）
  growLifeLayer: false,
  availableVictoryLines: ['territory', 'economy', 'singularity', 'survival'],
  // install / tick / onAddPlayer / onAddAI / routeIntent / snapshot 均留空 → 走主干默认路径
};

registerMode(rts);
export default rts;
