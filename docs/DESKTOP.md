# 桌面版

```bash
pnpm desktop            # 开发：Vite + Tauri 热重载
pnpm desktop:signed     # 构建 release 并 ad-hoc 签名
pnpm test:rust          # Rust 单元测试
```

`desktop:signed` 会构建、ad-hoc 签名、覆盖安装到 `/Applications/Papertable.app`，
然后**删掉 `target/` 下的 .app**——系统里始终只保留一份可启动的版本，就是最新那份。
加 `--no-install` 可只构建不安装。

## 为什么必须只留一份

三份 bundle（`/Applications`、`target/release`、`target/debug`）共用同一个
bundle id `com.papertable.app`、同一个版本号 `0.1.0`、**同一个 SQLite 数据库和同一条
本机配置文件**。Spotlight、Dock、Finder 都能启动任意一份，而界面上分辨不出打开的是哪一份。

后果是「改了没生效」这种最难查的现象：应用照常启动、功能都在，只是全是旧代码。
曾经因此对着三小时前的构建做验收。

三道防线：

1. **构建脚本装完即清**，只留 `/Applications` 那一份可启动。
2. **设置页显示这一份构建是什么**：git commit（带未提交标记）、构建时间、可执行文件
   路径。不是从 `/Applications` 启动的会额外显示一条红色警告。
3. **单实例**：第二次启动聚焦已有窗口，而不是再开一个进程。两份不同版本同时跑在
   同一个数据库上，是跨进程版的多标签页问题——每个进程各持一份内存基线，互相不可见。

安装这一步一开始是缺的，结果是「改完重新构建」之后打开的仍然是 `/Applications` 里的
旧版本，而界面上看不出任何异常——只会觉得改动没生效。

ad-hoc 签名的内容哈希每次构建都不同。Papertable 因此不再使用系统钥匙串保存 API
密钥，以免 macOS 每次把更新后的构建当成新应用、打开时就索要登录钥匙串密码。

## 为什么要 ad-hoc 签名

`codesign --sign -` **不是为了绕过 Gatekeeper**——本地构建的应用没有 quarantine
扩展属性，双击就能开、零弹窗。

它的重要性主要在于 bundle 完整性检查，以及未来可能接入的文件夹访问授权。API 密钥
与签名身份完全脱钩，重新构建或覆盖安装不会触发钥匙串授权框。

## 数据在哪

| 内容                       | 位置                                                                  |
| -------------------------- | --------------------------------------------------------------------- |
| 全部业务数据               | `~/Library/Application Support/com.papertable.app/papertable.sqlite3` |
| 接口地址、模型名、API 密钥 | 同目录的 `provider.json`，权限 0600                                   |

数据库**绝不放进 vault**：WAL 文件在 Obsidian 知识库或云同步目录里是损坏源，而且
Obsidian 会去索引它。

`provider.json` 只允许当前 macOS 用户读写；它不会进入 SQLite、导出包、日志或 Git。
旧版曾写入系统钥匙串的密钥不会被新版本读取。升级后在设置页重新保存一次 API 密钥，
以后打开应用就不会再出现钥匙串密码框。

## 迁移：从 web 版接手数据

**IndexedDB 无法自动迁移。** 现有数据在你打开 `127.0.0.1:5173` 的那个*浏览器 profile*
里；Tauri 在 macOS 用 WKWebView，数据存储按 bundle identifier 隔离，桌面应用看不见
那个数据库。没有任何 crate、插件或 Tauri API 能读另一个浏览器的 IndexedDB。

所以是显式交接：

1. web 版设置页 →「导出整库 JSON」（一个文件覆盖全部 12 张表）；
2. 桌面版设置页 →「导入整库 JSON」；
3. 导入后会立刻重新读出来逐表比对，结果显示在提示里。**比对不一致就不要继续用。**

web 端的 IndexedDB 全程不动，可以作为数周的实时回滚。

## 要分发给别人

自用不需要下面这些。

1. Apple 开发者账号（$99/年）→ **Developer ID Application** 证书。
   不要用「Mac App Distribution」——那是 App Store 的，会强制沙箱，而沙箱下拿不到
   任意路径的知识库。
2. `tauri.conf.json` 里配 `bundle.macOS.signingIdentity`、`hardenedRuntime: true`、
   entitlements 文件。公证要求 hardened runtime。
3. 公证：
   ```bash
   xcrun notarytool submit Papertable.dmg --apple-id … --team-id … \
     --password <app-specific> --wait
   xcrun stapler staple Papertable.dmg
   ```
4. 自动更新：`tauri-plugin-updater` + minisign 密钥对
   （`pnpm tauri signer generate`）+ GitHub Releases 上的静态 `latest.json`。
   **更新签名与 Apple 签名互相独立**：没有 Apple 账号也能做能用的自更新，只是用户
   首次安装时要手动过一次 Gatekeeper。
5. 通用二进制：`--target universal-apple-darwin`（多装两个 Rust target，构建时间大致翻倍）。

## CI

`.github/workflows/ci.yml` 有三个 job：

- `verify`（ubuntu）——typecheck / lint / format / 单测 / build / Playwright。
  **永远不能删**：`tauri-driver` 需要 WebKitWebDriver，而它在 macOS 上不存在，
  所以没有办法对真实 Tauri 窗口跑 e2e。web 构建是这个项目唯一可能的 e2e 覆盖。
- `rust`（ubuntu）——`cargo fmt --check`、`clippy -D warnings`、`cargo test`。
  持久化与 vault 的语义全靠这些测试守着。
- `desktop`（macos-14，手动触发）——`tauri build --debug` 并上传产物，
  这样不装本地 Rust 工具链也能拿到一个可运行的构建。
