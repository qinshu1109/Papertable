# 桌面版

```bash
pnpm desktop            # 开发：Vite + Tauri 热重载
pnpm desktop:signed     # 构建 release 并 ad-hoc 签名
pnpm test:rust          # Rust 单元测试
```

`desktop:signed` 会构建、ad-hoc 签名，**并覆盖安装到 `/Applications/Papertable.app`**。
加 `--no-install` 可只构建不安装，产物在 `src-tauri/target/release/bundle/macos/`。

安装这一步一开始是缺的，结果是「改完重新构建」之后打开的仍然是 `/Applications` 里的
旧版本，而界面上看不出任何异常——只会觉得改动没生效。

ad-hoc 签名的内容哈希每次构建都不同，所以**更新后钥匙串里的密钥可能读不出来**，
需要在设置页重填一次。设置页会如实显示密钥当前在钥匙串还是在回落文件里。

## 为什么要 ad-hoc 签名

`codesign --sign -` **不是为了绕过 Gatekeeper**——本地构建的应用没有 quarantine
扩展属性，双击就能开、零弹窗。

它重要是因为 **macOS 把钥匙串 ACL 和 TCC 授权绑在代码签名身份上**。没有稳定身份，
每次重新构建都是一个「新」应用：已存的 API 密钥读不出来，日后若把知识库移进
`~/Documents` 需要的文件夹访问授权也要重新弹一次。

换用正式的 Developer ID 证书重新签名时，签名身份变了，钥匙串里的密钥同样会读不到，
需要在设置页重新填一次。这是 macOS 的设计，不是 bug。

## 数据在哪

| 内容             | 位置                                                                  |
| ---------------- | --------------------------------------------------------------------- |
| 全部业务数据     | `~/Library/Application Support/com.papertable.app/papertable.sqlite3` |
| API 密钥         | 系统钥匙串（服务 `com.papertable.app`）；不可用时回落到下一行         |
| 接口地址、模型名 | 同目录的 `provider.json`，权限 0600                                   |

数据库**绝不放进 vault**：WAL 文件在 Obsidian 知识库或云同步目录里是损坏源，而且
Obsidian 会去索引它。

设置页会如实显示密钥到底在钥匙串还是在回落文件里。回落显示成「已进钥匙串」会让人
以为磁盘上没有明文密钥，所以这一处不做美化。

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
