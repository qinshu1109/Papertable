#!/usr/bin/env bash
# 构建并 ad-hoc 签名自用的桌面版。
#
# `codesign --sign -` **不是为了 Gatekeeper**——本地构建的应用没有 quarantine
# 扩展属性，双击就能开、零弹窗。它仍能让 bundle 完整性检查与未来的 TCC 授权行为
# 更可预测；API 密钥不再依赖钥匙串，避免 ad-hoc 签名每次构建变化导致反复弹密码。
#
# 要分发给别人则是另一回事：需要 Apple 开发者账号（$99/年）、Developer ID 证书、
# hardened runtime、公证和 stapler。见 docs/DESKTOP.md。
set -euo pipefail

cd "$(dirname "$0")/.."

# rustup 的默认安装位置。非登录 shell、CI、以及从别的工具里调用时，`~/.cargo/env`
# 不会被 source，`cargo` 不在 PATH 里；tauri 的第一步就是 `cargo metadata`，
# 报的错是 "No such file or directory (os error 2)"，看不出缺的是 cargo。
[ -d "$HOME/.cargo/bin" ] && PATH="$PATH:$HOME/.cargo/bin"
command -v cargo >/dev/null || {
  echo "找不到 cargo。装 Rust：https://rustup.rs" >&2
  exit 127
}

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
echo "提示：桌面端 API 密钥保存在应用数据目录的 0600 文件，不会访问系统钥匙串。"
