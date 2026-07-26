#!/usr/bin/env bash
# 构建并 ad-hoc 签名自用的桌面版。
#
# `codesign --sign -` **不是为了 Gatekeeper**——本地构建的应用没有 quarantine
# 扩展属性，双击就能开、零弹窗。它重要是因为 macOS 把**钥匙串 ACL 和 TCC 授权
# 绑在代码签名身份上**：没有稳定身份，每次重新构建都是一个「新」应用，会丢掉
# 已存的 API 密钥、以及日后可能需要的文件夹访问授权。
#
# 要分发给别人则是另一回事：需要 Apple 开发者账号（$99/年）、Developer ID 证书、
# hardened runtime、公证和 stapler。见 docs/DESKTOP.md。
set -euo pipefail

cd "$(dirname "$0")/.."

MODE="${1:-release}"
[[ "$MODE" == "--no-install" ]] && MODE="release"
case "$MODE" in
  release) pnpm tauri build --bundles app ;;
  debug)   pnpm tauri build --debug --bundles app ;;
  *) echo "用法: $0 [release|debug]" >&2; exit 2 ;;
esac

APP="src-tauri/target/${MODE}/bundle/macos/Papertable.app"
[ -d "$APP" ] || { echo "没有找到构建产物：$APP" >&2; exit 1; }

# --force：重新构建后要覆盖旧签名。
# --deep：连同内嵌的框架一起签。
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"

# 安装到 /Applications。
#
# 之前这一步是缺的：构建产物留在 target/ 里，而用户运行的是 /Applications 里那份，
# 于是「改完重新构建」之后打开的仍然是旧版本，且看不出任何异常。
# 传 --no-install 可跳过。
if [[ " $* " != *" --no-install "* ]]; then
  # 正在运行的话先退出，否则替换 bundle 会留下半新半旧的目录。
  pkill -f "Papertable.app" 2>/dev/null || true
  pkill -f "MacOS/papertable" 2>/dev/null || true
  sleep 1
  rm -rf "/Applications/Papertable.app"
  cp -R "$APP" /Applications/
  echo "已安装到 /Applications/Papertable.app"

  # 装完就把 target/ 里的 bundle 删掉，**只留一份可启动的**。
  #
  # 三份 bundle 共用 bundle id、共用同一个数据库，Spotlight / Dock / Finder 都能
  # 启动任意一份，而界面上曾经无从分辨。留着它们唯一的作用就是让人误开旧版本。
  # 二进制本身留在 target/ 里，增量编译不受影响，只是不再是一个可双击的 .app。
  rm -rf src-tauri/target/release/bundle/macos/Papertable.app \
         src-tauri/target/debug/bundle/macos/Papertable.app
  echo "已清除 target/ 下的可启动副本，现在系统里只有一份 Papertable.app"
fi

echo
echo "已签名：$APP"
codesign -dv "$APP" 2>&1 | grep -E "Signature|Identifier" || true
echo
echo "安装：把它拖进 /Applications 即可。"
echo "注意：换用正式的 Developer ID 证书重新签名时，钥匙串里已存的 API 密钥"
echo "会因为签名身份变化而无法读取，需要在设置页重新填一次。"
