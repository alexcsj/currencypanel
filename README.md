# currencypanel

GNOME Shell 擴充功能：在 top panel 常駐顯示台灣銀行(Bank of Taiwan)USD / JPY / CNY / EUR 對台幣的**現金匯率－本行賣出**報價，每小時自動更新一次。

```
USD 32   JPY 0.2036   CNY 4.789   EUR 37.28
```

下拉選單可以看到各幣別完整名稱、最後更新時間，以及「立即更新」按鈕手動刷新。

## 運作原理

rate.bot.com.tw 現在有反爬蟲防護(JS proof-of-work 挑戰)，一般的 HTTP client（`curl`、`libsoup`）直接抓會被擋下，拿到的是驗證頁而不是真正的匯率表格。所以這個擴充功能不是自己發 HTTP request，而是：

1. `fetch-rate.js`：一個獨立的 `gjs` 小程式，用背景 WebKitGTK 瀏覽器引擎（`Gtk.OffscreenWindow` + `WebKit2.WebView`，畫面不會跳出來）像真實瀏覽器一樣載入台銀網頁、讓 JS 挑戰自動通過，再從渲染後的 DOM 解析出四種幣別的現金賣出價，寫進 `~/.cache/currency-rate@csj1980.local/rates.json`。
2. `extension.js`：GNOME Shell 擴充功能本體，面板顯示 + 下拉選單，每小時透過 `Gio.Subprocess` 呼叫一次 `fetch-rate.js` 刷新資料，並監看快取檔變化即時更新畫面。刷新失敗時會保留舊資料，不會讓面板空白。

## 安裝

### 相依套件

- `gjs`
- `webkit2gtk`（GObject Introspection typelib，4.1 或 4.0 版皆可，腳本會自動偵測）

| 發行版 | 安裝指令 |
|---|---|
| Arch / Manjaro | `sudo pacman -S gjs webkit2gtk-4.1` |
| Ubuntu 24.04+ / Debian 13+ | `sudo apt install gjs gir1.2-webkit2-4.1 libwebkit2gtk-4.1-0` |
| Ubuntu 22.04 / 較舊 Debian | `sudo apt install gjs gir1.2-webkit2-4.0 libwebkit2gtk-4.0-37` |
| Fedora | `sudo dnf install gjs webkit2gtk4.1` |
| openSUSE | `sudo zypper install gjs webkit2gtk3-soup2 typelib-1_0-WebKit2-4_1` |

### 一鍵安裝

```bash
curl -fsSL https://raw.githubusercontent.com/alexcsj/currencypanel/main/install.sh | bash
```

### 或先 clone 再裝

```bash
git clone https://github.com/alexcsj/currencypanel.git
cd currencypanel
./install.sh
```

`install.sh` 會檢查相依套件（缺少的話會列出對應發行版的安裝指令，不會自動 `sudo` 幫你裝），然後把擴充功能複製到 `~/.local/share/gnome-shell/extensions/currency-rate@csj1980.local`。

### 啟用

**第一次安裝**：GNOME Shell 需要重新掃描擴充功能目錄才能看到新裝的擴充功能，請**登出再登入**（或重開機）一次，再執行：

```bash
gnome-extensions enable currency-rate@csj1980.local
```

之後要更新版本（重新執行 `install.sh`）不需要再登出，直接：

```bash
gnome-extensions disable currency-rate@csj1980.local
gnome-extensions enable currency-rate@csj1980.local
```

## 已知限制

- 依賴 rate.bot.com.tw 目前的頁面結構（`td[data-table="本行現金賣出"]`）與反爬蟲機制的運作方式，若台銀改版或加強防護，`fetch-rate.js` 可能需要跟著調整。
- 每次刷新都會短暫背景啟動一個 WebKitGTK 行程，比一般擴充功能耗資源一些；預設每小時刷新一次，日常使用影響很小。
