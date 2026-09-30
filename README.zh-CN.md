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
| `pack` | 负载白名单，默认 `["dist","node_modules","assets","package.json","app.json"]` |

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
