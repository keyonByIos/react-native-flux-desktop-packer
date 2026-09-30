// util.js —— 打包用的通用小工具：递归拷贝（可过滤）、命令探测、目录体积、日志。
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function log(msg) {
  console.log(msg);
}
function step(msg) {
  console.log('\n\x1b[36m==> ' + msg + '\x1b[0m');
}
function ok(msg) {
  console.log('\x1b[32m    ' + msg + '\x1b[0m');
}
function warn(msg) {
  console.log('\x1b[33m    ! ' + msg + '\x1b[0m');
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

// 递归拷贝 src → dest。filter(relAbs, isDir) 返回 false 则跳过该项。
function copyTree(src, dest, filter) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    ensureDir(dest);
    for (const name of fs.readdirSync(src)) {
      const s = path.join(src, name);
      const d = path.join(dest, name);
      const isDir = fs.lstatSync(s).isDirectory();
      if (filter && !filter(s, isDir)) continue;
      copyTree(s, d, filter);
    }
  } else if (st.isFile()) {
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
  }
}

// 目录体积（字节）
function dirSize(p) {
  let total = 0;
  try {
    for (const name of fs.readdirSync(p)) {
      const s = path.join(p, name);
      const st = fs.lstatSync(s);
      if (st.isDirectory()) total += dirSize(s);
      else if (st.isFile()) total += st.size;
    }
  } catch {
    /* ignore */
  }
  return total;
}

function fmtMB(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

// 探测命令是否可用（返回可执行路径或 null）。cmd 可为绝对路径。
function which(cmd) {
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd) ? cmd : null;
  const probe = spawnSync(cmd, ['--version'], { windowsHide: true });
  if (probe.error || probe.status !== 0) {
    // 有些工具（go）用 version 而非 --version
    const probe2 = spawnSync(cmd, ['version'], { windowsHide: true });
    if (probe2.error || probe2.status !== 0) return null;
  }
  // 用 where 定位真实路径
  const w = spawnSync('where', [cmd], { windowsHide: true });
  if (!w.error && w.status === 0) {
    const first = String(w.stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first) return first;
  }
  return cmd; // 已知能跑，但拿不到绝对路径
}

// 运行命令，失败抛错。返回 stdout。
function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, Object.assign({ stdio: 'inherit', windowsHide: true }, opts || {}));
  if (r.error) throw new Error(`执行失败 ${cmd}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 退出码 ${r.status}`);
  return r;
}

module.exports = { log, step, ok, warn, rmrf, ensureDir, copyTree, dirSize, fmtMB, which, run };
