// scripts/qa_chrome_keeper.mjs — 用 node 父进程 spawn 保活 headless Chrome（本会话直接起会被清理）
// 用法：node scripts/qa_chrome_keeper.mjs [port] [userDataDir]
import { spawn } from 'node:child_process';

const PORT = process.argv[2] || '9341';
const UDD = process.argv[3] || 'C:/Users/JM/AppData/Local/Temp/cr-qa';
const CHROME = process.env.CHROME || 'C:/Users/JM/.agent-browser/browsers/chrome-153.0.8010.36/chrome.exe';

const args = [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-crashpad',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${UDD}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-dev-shm-usage',
  '--window-size=1440,900',
  'about:blank',
];

const child = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: false });
child.stdout.on('data', d => process.stdout.write('[chrome-out] ' + d));
child.stderr.on('data', d => process.stdout.write('[chrome-err] ' + d));
child.on('exit', (code, sig) => { console.log('[chrome] exited', code, sig); process.exit(code || 0); });

// 父进程空转保活
setInterval(() => {}, 1 << 30);
console.log('[keeper] chrome pid', child.pid, 'port', PORT);
