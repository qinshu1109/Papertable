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

echo
echo "已签名：$APP"
codesign -dv "$APP" 2>&1 | grep -E "Signature|Identifier" || true
echo
echo "安装：把它拖进 /Applications 即可。"
echo "注意：换用正式的 Developer ID 证书重新签名时，钥匙串里已存的 API 密钥"
echo "会因为签名身份变化而无法读取，需要在设置页重新填一次。"
