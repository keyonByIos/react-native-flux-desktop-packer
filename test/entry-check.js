// test/entry-check.js —— 入口/产物一致性校验（config.validateEntry）的可跑用例。
// 无第三方依赖：node assert + 计数 + 退出码。跑法：`node test/entry-check.js` 或 `npm test`。
// 覆盖 H 项「打包前校验 main 指向的文件存在且非陈旧」的四个分支 + 真实 gallery 通过。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../lib/config');

let pass = 0;
const failures = [];

// 建一个临时项目夹具：app.json(main) + dist/App.js(入口) + src/index.tsx(源码)，各自设 mtime。
function fixture(mainRel, entryAgeMs, srcAgeMs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxpack-test-'));
  fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify({ name: 'Fixture', main: mainRel }));
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  const entry = path.join(dir, 'dist', 'App.js');
  const src = path.join(dir, 'src', 'index.tsx');
  fs.writeFileSync(entry, 'console.log(1);');
  fs.writeFileSync(src, 'export default 1;');
  const now = Date.now();
  fs.utimesSync(entry, new Date(now - entryAgeMs), new Date(now - entryAgeMs));
  fs.utimesSync(src, new Date(now - srcAgeMs), new Date(now - srcAgeMs));
  return dir;
}

function it(name, fn) {
  try {
    fn();
    pass++;
    console.log('  \u2713 ' + name);
  } catch (e) {
    failures.push({ name, msg: e.message });
    console.log('  \u2717 ' + name + '\n      ' + e.message.split('\n')[0]);
  }
}

function throwsLike(re, fn) {
  assert.throws(fn, (err) => {
    assert.ok(re.test(err.message), `错误信息不匹配 /${re.source}/ ：${err.message}`);
    return true;
  });
}

console.log('entry-check: validateEntry / loadConfig');

it('入口产物比源码新 → 通过', () => {
  const cfg = loadConfig(fixture('dist/App.js', 1000, 60_000));
  assert.strictEqual(cfg.mainRel.split(path.sep).join('/'), 'dist/App.js');
});

it('入口产物早于源码 → 判陈旧并拦截', () => {
  throwsLike(/疑似陈旧/, () => loadConfig(fixture('dist/App.js', 60_000, 1000)));
});

it('main 指向不存在的历史遗留文件 → 判缺失并拦截', () => {
  throwsLike(/入口产物不存在/, () => loadConfig(fixture('dist/Gallery.js', 1000, 60_000)));
});

it('app.json 缺 main 且无 package.json.main → 无法确定入口', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxpack-test-'));
  fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify({ name: 'NoMain' }));
  throwsLike(/无法确定入口/, () => loadConfig(dir));
});

it('根级 .js 配置比 dist 新 → 不算源码、不误判陈旧', () => {
  const dir = fixture('dist/App.js', 60_000, 5_000); // 入口旧、src/index.tsx 新 → 本应陈旧
  // 但把 src 里唯一源码文件删掉，只留一个更新的 metro.config.js（根级配置）：不应触发陈旧
  fs.rmSync(path.join(dir, 'src', 'index.tsx'));
  const cfgJs = path.join(dir, 'metro.config.js');
  fs.writeFileSync(cfgJs, 'module.exports = {};');
  const now = Date.now();
  fs.utimesSync(cfgJs, new Date(now - 1000), new Date(now - 1000)); // 比入口新
  const cfg = loadConfig(dir); // 不应抛错
  assert.ok(cfg.mainRel);
});

console.log(`\n${pass} passing, ${failures.length} failing`);
process.exit(failures.length ? 1 : 0);
