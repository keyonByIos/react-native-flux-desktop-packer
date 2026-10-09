# react-native-flux-desktop-packer（中文）

[English](./README.md) | **简体中文**

<p align="center">
  <a href="https://www.npmjs.com/package/react-native-flux-desktop-packer"><img src="https://img.shields.io/npm/v/react-native-flux-desktop-packer?style=flat-square&color=cb3837" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/react-native-flux-desktop-packer"><img src="https://img.shields.io/npm/dm/react-native-flux-desktop-packer?style=flat-square" alt="npm downloads"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/platform-win32-lightgrey?style=flat-square" alt="win32 only">
</p>

把 [react-native-flux-desktop](https://www.npmjs.com/package/react-native-flux-desktop) 应用打包成**单个自包含的 Windows `.exe`**——不用 Electron、不需要安装器、目标机器也不需要装 Node.js。终端用户双击一个文件，直接得到原生窗口。

## 工作原理

```
app.json ──▶ [1] 组装载        dist/ + node_modules/ + assets/ + 你的 node.exe
           ──▶ [2] 压缩         payload.zip（Optimal deflate）
           ──▶ [3] 图标         app.png → .syso（经 go-winres，可选）
           ──▶ [4] go build     Go 启动器 go:embed 内嵌负载 + -H windowsgui
           ──▶ [5] 交付         <output>/<Name>-<version>.exe
```

启动器是一个极小的 Go 二进制，整个运行时**内嵌**其中（`go:embed`）。首次启动时自解压到 `%LOCALAPPDATA%\<AppName>\app-<内容哈希>\`（含 zip-slip 防护、原子 rename），然后用捆绑的 `node.exe` 运行入口 JS。按内容哈希缓存意味着：新版本自动重解压，未变化的构建秒开。

打包机没装 Go？packer 会**自动降级**为「便携文件夹 + run.cmd」——应用照样跑，只是不再是单文件。

## 安装

```sh
npm install --save-dev react-native-flux-desktop-packer
```

要求（打包机）：Windows + Node.js ≥ 18。可选：[Go](https://go.dev)（单 exe 路径）、[`go-winres`](https://github.com/tc-hib/go-winres)（自定义 exe 图标）——缺失时都会优雅降级。

## 使用

**1.** 项目根目录准备 `app.json`：

```json
{
  "name": "MyApp",
  "version": "0.1.0",
  "icon": "assets/icon.png",
  "main": "dist/App.js",
  "output": "output"
}
```

| 字段 | 用途 |
|---|---|
| `name` | 窗口标题、exe 文件名、缓存与数据目录名（**必填**） |
| `version` | exe 文件名后缀 + Windows 版本资源 |
| `icon` | 嵌入 exe 的 PNG 图标（可选，缺省用默认图标） |
| `main` | 编译后的入口 JS；缺省回落 `package.json` 的 `main` |
| `output` | 产物落地目录（默认 `build`） |
| `pack` | 负载白名单，默认 `["dist","node_modules","assets","package.json","app.json"]`；另含 `pack.mode`（默认 `folder`，或 `sea`）与 `pack.assets`（资源目录，默认 `assets`） |

**2.** 先编译应用，再打包：

```sh
npm run build      # 你的 tsc 步骤——产出 dist/
npx flux-pack      # → output/MyApp-0.1.0.exe
```

CLI 参数：

```
flux-pack                   在当前目录的项目打包（读 app.json）
flux-pack --project <dir>   指定项目根
flux-pack --keep            保留中间工作目录 .flux-pack/（调试用）
```

**编程式 API：**

```js
const { pack } = require('react-native-flux-desktop-packer');
await pack({ projectRoot: __dirname, keep: false });
```

## 负载里装了什么

stage 阶段会拷贝你的 `dist/`、`node_modules/`、`assets/`、`package.json`、`app.json`，外加**正在运行 packer 的那个 `node.exe`**（N-API 跨大版本 ABI 稳定，捆绑的 node 加载你的 `.node` 原生插件没有问题）。win32-x64 上用不到的平台专属预编译包（darwin/linux 的 canvas 二进制、`ffmpeg-static`）会被过滤掉以控制体积。

运行时启动器会注入 `FLUX_PACKAGED=1` 和 `FLUX_APP_DIR=<AppName>`，库会据此把 KV/日志数据路由到 `%APPDATA%\<AppName>\`——exe 放进 `Program Files` 也没有可写路径问题。

## SEA 单文件模式（`pack.mode: "sea"`）

上面的默认路径走的是**文件夹/启动器**负载（一个 Go exe 内嵌 `dist/` + `node_modules/` + `node.exe` 的 zip）。首启会自解压出一份可读的 **JS 源码树**到 `%LOCALAPPDATA%`——能跑，但解压出的 `dist/**/*.js` 和 `node_modules/` 让人一眼看出这是个 JS 项目。

在 `app.json` 里设 `"pack": { "mode": "sea" }` 即切到 **Node SEA**（单可执行应用）构建，修掉这个观感。现有 `folder` 路径原封不动——把字段改回去即可回退。

```
app.json ─▶ [1] esbuild      全部 JS → 一个 minified app.cjs（无 dist/ 树、无 node_modules）
         ─▶ [2] SEA 资产     app.cjs + 原生 .node（自研 + skia）+ icudtl.dat + 图片资源 → 内嵌进 blob
         ─▶ [3] rcedit       在 node.exe 副本上写图标 + FileDescription/ProductName/…（在注入之前）
         ─▶ [4] postject     将 NODE_SEA_BLOB 注入该 exe
         ─▶ [5] 子系统       PE OptionalHeader.Subsystem 3→2（GUI），双击不弹控制台
         ─▶ [6] 交付         <output>/<Name>-<version>.exe（单文件）
```

运行时，`node:sea` 跑一个 bootstrap（即 SEA 的 `main`）：把内嵌的原生/资源一次性自解压到隐藏的 `%LOCALAPPDATA%\<AppName>\run-<stamp>\`，安装原生解析钩子（skia 走 `NAPI_RS_NATIVE_LIBRARY_PATH`，你的 `.node` 走 `Module._resolveFilename`），`chdir` 到解压出的资源目录，设 `FLUX_PACKAGED=1` / `FLUX_APP_DIR`，然后 `createRequire` 加载不透明的 `app.cjs`。`.extracted` 标记使二次启动跳过重复解压。**没有 `node.exe` 子进程**——任务管理器显示品牌化的 `<App>.exe` 名与图标。

收益：磁盘上不再有 JS 源码树——解压目录只有一份 minified `app.cjs` 加不透明的编译二进制（`.node`/`.dat`）与你的图片资源。

**前置要求：** 构建机需支持 SEA 的 Node.js ≥ 20（用 `--experimental-sea-config`），外加 `esbuild` 和 `postject`（声明为 `optionalDependencies`；`rcedit` 也是选填—图标/版本注入缺失时优雅跳过）。缺 `esbuild`/`postject` → packer 报错并给出需执行的 `npm i`。

**诚实的限制：**
- **非绝对防逆向。** SEA blob 有公开提取工具，`app.cjs` 是 minified 明文 JS。本模式*抬高成本*、去掉“一眼是 JS 项目”的观感；**并不能**让源码不可还原。若要更硬，在 bundle 上叠 `bytenode`/V8 字节码（本次范围外）。
- **运行期仍会写不透明原生 + 一份 `app.cjs`** 到隐藏的 `%LOCALAPPDATA%` 目录。Node SEA 的 blob 只能嵌 JS——原生 `.node` 插件与非 JS 资源必须落到真实路径（这是 C1 自解压的取舍；唯一替代是 exe 旁放 `native/` 文件夹）。
- **体积**增长到约为 node.exe + blob + 内嵌原生（gallery demo 约 130–140 MB）。

## 打包前硬校验

复制动作开始之前，packer 会快速失败：

- 缺 `app.json` 或缺 `name` → 报错并给出修复动作
- 入口 JS 不存在 → 提示先执行编译
- 入口 JS 比任何源文件都**旧**（忘了重新编译）→ 报错并列出两个文件与修改时间——这一条救过不止一次发版

## 仓库结构

```
bin/flux-pack.js     CLI 入口（npx flux-pack）
lib/                 配置读取 / 图标构建 / 主流程编排
launcher/            Go 启动器源码 + 占位 payload.zip（满足 go:embed 静态检查）
test/entry-check.js  入口校验器的冒烟测试
```

## 相关仓库

- [react-native-flux-desktop](https://www.npmjs.com/package/react-native-flux-desktop) —— 本工具打包的对象：桌面渲染栈。
- [react-native-flux](https://github.com/keyonByIos/react-native-flux) —— 父仓库。

## 许可证

[MIT](./LICENSE)
