// 临时探针：跑 npm test 全套并汇总统计（尾行可能丢失，故自解析 TAP 汇总）
import { spawn } from 'node:child_process';

const files = [
  'tests/kernels.test.mjs', 'tests/engine.test.mjs', 'tests/api.test.mjs',
  'tests/multiplayer.test.mjs', 'tests/go_mode.test.mjs', 'tests/life_cell_combat.test.mjs',
  'tests/rts_spacing.test.mjs', 'tests/room_lobby.test.mjs', 'tests/room_settings.test.mjs',
  'tests/admin.test.mjs', 'tests/maintenance.test.mjs',
  'tests/victory_config.test.mjs', 'tests/victory_config.qa.test.mjs',
];
const p = spawn(process.execPath, ['--test', '--expose-gc', ...files], {
  cwd: 'D:/workspace/Game', stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
p.stdout.on('data', d => out += d);
p.stderr.on('data', d => out += d);
p.on('close', code => {
  const lines = out.split(/\r?\n/);
  const summary = lines.filter(l => /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration)/.test(l.trim()));
  const fails = lines.filter(l => /^not ok /.test(l.trim()));
  console.log('EXIT=' + code);
  console.log('--- SUMMARY ---');
  console.log(summary.join('\n'));
  console.log('--- FAIL LINES (' + fails.length + ') ---');
  console.log(fails.slice(0, 40).join('\n'));
});
