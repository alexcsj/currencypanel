#!/usr/bin/env bash
# currencypanel 安裝腳本
# 用法：
#   git clone https://github.com/alexcsj/currencypanel.git && cd currencypanel && ./install.sh
# 或不 clone，直接：
#   curl -fsSL https://raw.githubusercontent.com/alexcsj/currencypanel/main/install.sh | bash

set -euo pipefail

UUID="currency-rate@csj1980.local"
REPO_TARBALL_URL="https://github.com/alexcsj/currencypanel/archive/refs/heads/main.tar.gz"
EXTENSIONS_DIR="$HOME/.local/share/gnome-shell/extensions"
TARGET_DIR="$EXTENSIONS_DIR/$UUID"

log() { printf '==> %s\n' "$1"; }
warn() { printf '!! %s\n' "$1" >&2; }

# --- 1. 找出擴充功能原始檔的位置 -------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

if [ -d "$SCRIPT_DIR/$UUID" ]; then
    # 從已 clone 的 repo 內執行
    SOURCE_DIR="$SCRIPT_DIR/$UUID"
    CLEANUP_DIR=""
else
    # 透過 curl | bash 執行，沒有本機原始碼，先下載一份到暫存目錄
    if ! command -v curl >/dev/null 2>&1; then
        warn "找不到 curl，請先安裝 curl 再重試。"
        exit 1
    fi
    TMP_DIR="$(mktemp -d)"
    CLEANUP_DIR="$TMP_DIR"
    trap '[ -n "$CLEANUP_DIR" ] && rm -rf "$CLEANUP_DIR"' EXIT

    log "下載 currencypanel 原始碼..."
    curl -fsSL "$REPO_TARBALL_URL" -o "$TMP_DIR/repo.tar.gz"
    tar -xzf "$TMP_DIR/repo.tar.gz" -C "$TMP_DIR"
    SOURCE_DIR="$(find "$TMP_DIR" -mindepth 1 -maxdepth 1 -type d -name 'currencypanel-*')/$UUID"

    if [ ! -d "$SOURCE_DIR" ]; then
        warn "下載的內容裡找不到 $UUID/，安裝中止。"
        exit 1
    fi
fi

# --- 2. 檢查相依套件（gjs、WebKit2 GI typelib）------------------------------
log "檢查相依套件..."

if ! command -v gjs >/dev/null 2>&1; then
    warn "找不到 gjs。"
    MISSING_GJS=1
else
    MISSING_GJS=0
fi

WEBKIT_OK=0
if command -v gjs >/dev/null 2>&1; then
    if gjs -c '
        let ok = false;
        for (const v of ["4.1", "4.0"]) {
            try {
                imports.gi.versions.WebKit2 = v;
                void imports.gi.WebKit2;
                ok = true;
                break;
            } catch (e) {}
        }
        if (!ok) imports.system.exit(1);
    ' >/dev/null 2>&1; then
        WEBKIT_OK=1
    fi
fi

if [ "$MISSING_GJS" = "1" ] || [ "$WEBKIT_OK" = "0" ]; then
    warn "缺少必要相依套件（gjs 與 WebKit2 4.1/4.0 的 GObject Introspection typelib）。"
    warn "這個擴充功能用背景 WebKitGTK 瀏覽器引擎讀取台銀網頁（繞過反爬蟲驗證），需要這些套件才能運作。"
    echo
    echo "  Arch / Manjaro:      sudo pacman -S gjs webkit2gtk-4.1"
    echo "  Ubuntu 24.04+ / Debian 13+:"
    echo "                       sudo apt install gjs gir1.2-webkit2-4.1 libwebkit2gtk-4.1-0"
    echo "  Ubuntu 22.04 / 較舊 Debian（只有 4.0）:"
    echo "                       sudo apt install gjs gir1.2-webkit2-4.0 libwebkit2gtk-4.0-37"
    echo "  Fedora:              sudo dnf install gjs webkit2gtk4.1"
    echo "  openSUSE:            sudo zypper install gjs webkit2gtk3-soup2 typelib-1_0-WebKit2-4_1"
    echo
    warn "請安裝對應套件後重新執行本腳本。"
    exit 1
fi

log "相依套件 OK"

# --- 3. 安裝（複製）到 GNOME Shell 擴充功能目錄 -----------------------------
mkdir -p "$EXTENSIONS_DIR"

if [ -e "$TARGET_DIR" ] || [ -L "$TARGET_DIR" ]; then
    log "偵測到舊版本，先移除 $TARGET_DIR"
    rm -rf "$TARGET_DIR"
fi

log "安裝到 $TARGET_DIR"
cp -r "$SOURCE_DIR" "$TARGET_DIR"

echo
log "安裝完成！"
echo
if command -v gnome-extensions >/dev/null 2>&1 && gnome-extensions list 2>/dev/null | grep -qx "$UUID"; then
    echo "已偵測到 GNOME Shell 認得這個擴充功能，執行以下指令啟用："
    echo "  gnome-extensions enable $UUID"
else
    echo "第一次安裝：GNOME Shell 需要重新掃描擴充功能目錄才能看到新裝的擴充功能。"
    echo "請「登出後再登入」（或重新開機），再執行："
    echo "  gnome-extensions enable $UUID"
fi
