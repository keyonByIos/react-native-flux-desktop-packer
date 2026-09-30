#!/usr/bin/env node
// flux-pack —— react-native-flux-desktop 打包 CLI。
// 用法（在含 app.json 的项目根执行）：
//   flux-pack                 # 读当前目录 app.json，产 exe 到 app.json.output
//   flux-pack --project <dir> # 指定项目根
//   flux-pack --keep          # 保留中间工作目录 .flux-pack（调试用）
'use strict';
const path = require('path');
const { pack } = require('../lib');

function parseArgs(argv) {
  const opts = { projectRoot: process.cwd(), keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project' || a === '-p') opts.projectRoot = path.resolve(argv[++i] || '.');
    else if (a === '--keep') opts.keep = true;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

function help() {
  console.log(
    [
      'flux-pack —— 把 react-native-flux-desktop 应用打包成自包含 Windows exe',
      '',
      '用法：',
      '  flux-pack                  在当前项目根打包（读 app.json）',
      '  flux-pack --project <dir>  指定项目根',
      '  flux-pack --keep           保留中间目录 .flux-pack',
      '',
      'app.json 需含：name / version / icon / output / main（main 缺省回落 package.json.main）',
    ].join('\n'),
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    help();
    return;
  }
  try {
    await pack(opts);
  } catch (e) {
    console.error('\n\x1b[31m✘ 打包失败：\x1b[0m' + (e && e.message ? e.message : e));
    process.exit(1);
  }
}

main();
