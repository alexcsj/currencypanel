#!/usr/bin/env gjs
// 獨立抓取程式：用 WebKitGTK 載入台灣銀行牌告匯率頁面（讓反爬蟲的 JS 挑戰能像真實瀏覽器一樣通過），
// 解析出 USD/JPY/CNY/EUR 的「本行現金賣出」匯率，寫入 rates.json 快取檔後結束。
// 由 extension.js 以 Gio.Subprocess 定期呼叫，不常駐執行。

imports.gi.versions.Gtk = '3.0';
imports.gi.versions.WebKit2 = '4.1';

const { Gtk, WebKit2, GLib } = imports.gi;

// 這台機器的 GL/EGL 後端無法讓 WebKit 用硬體加速的 offscreen 渲染，
// 需要強制走軟體算繪，否則 Gtk.OffscreenWindow + WebView 會直接 abort。
GLib.setenv('WEBKIT_DISABLE_COMPOSITING_MODE', '1', true);
GLib.setenv('GDK_GL', 'disable', true);
GLib.setenv('LIBGL_ALWAYS_SOFTWARE', '1', true);
GLib.setenv('WEBKIT_DISABLE_DMABUF_RENDERER', '1', true);

const URL = 'https://rate.bot.com.tw/xrt?Lang=zh-TW';
const CURRENCIES = ['USD', 'JPY', 'CNY', 'EUR'];
const CACHE_DIR = GLib.build_filenamev([GLib.get_home_dir(), '.cache', 'currency-rate@csj1980.local']);
const PROFILE_DIR = GLib.build_filenamev([CACHE_DIR, 'webkit-profile']);
const OUTPUT_FILE = GLib.build_filenamev([CACHE_DIR, 'rates.json']);
const POLL_INTERVAL_MS = 1000;
const MAX_POLLS = 20;
const OVERALL_TIMEOUT_SEC = 40;

const EXTRACT_JS = `
(function() {
    const codes = ${JSON.stringify(CURRENCIES)};
    const result = {};
    const rows = document.querySelectorAll('table tbody tr');
    rows.forEach(function(row) {
        const curTd = row.querySelector('td[data-table="幣別"]');
        if (!curTd) return;
        const text = curTd.textContent;
        for (const code of codes) {
            if (text.indexOf('(' + code + ')') !== -1) {
                const sellTd = row.querySelector('td[data-table="本行現金賣出"]');
                if (sellTd) result[code] = sellTd.textContent.trim();
            }
        }
    });
    return JSON.stringify(result);
})()
`;

function fail(message) {
    printerr('fetch-rate: ' + message);
    imports.system.exit(1);
}

GLib.mkdir_with_parents(PROFILE_DIR, 0o700);

Gtk.init(null);

const dataManager = new WebKit2.WebsiteDataManager({
    base_data_directory: PROFILE_DIR,
    base_cache_directory: PROFILE_DIR,
});
const context = new WebKit2.WebContext({ website_data_manager: dataManager });
const win = new Gtk.OffscreenWindow();
const webview = new WebKit2.WebView({ web_context: context });
win.add(webview);
win.show_all();

const loop = GLib.MainLoop.new(null, false);
let pollCount = 0;
let settled = false;

function finish(success, data) {
    if (settled) return;
    settled = true;
    if (success) {
        const payload = JSON.stringify({
            updated: new Date().toISOString(),
            rates: data,
        }, null, 2);
        if (!GLib.file_set_contents(OUTPUT_FILE, payload)) {
            printerr('fetch-rate: 無法寫入 ' + OUTPUT_FILE);
            loop.quit();
            imports.system.exit(1);
            return;
        }
        print('fetch-rate: 已更新 ' + OUTPUT_FILE);
        loop.quit();
        imports.system.exit(0);
    } else {
        printerr('fetch-rate: 抓取失敗 - ' + data);
        loop.quit();
        imports.system.exit(1);
    }
}

function tryExtract() {
    pollCount++;
    webview.run_javascript(EXTRACT_JS, null, (view, result) => {
        if (settled) return;
        try {
            const jsResult = view.run_javascript_finish(result);
            const str = jsResult.get_js_value().to_string();
            const parsed = JSON.parse(str);
            const got = CURRENCIES.filter((c) => parsed[c]);
            if (got.length === CURRENCIES.length) {
                finish(true, parsed);
                return;
            }
        } catch (e) {
            // 頁面可能還在反爬蟲挑戰驗證中，尚未渲染出表格，稍後重試
        }
        if (pollCount >= MAX_POLLS) {
            finish(false, '重試 ' + MAX_POLLS + ' 次後仍未取得完整匯率表格');
            return;
        }
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_INTERVAL_MS, () => {
            tryExtract();
            return GLib.SOURCE_REMOVE;
        });
    });
}

webview.connect('load-changed', (view, loadEvent) => {
    if (loadEvent === WebKit2.LoadEvent.FINISHED) {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            tryExtract();
            return GLib.SOURCE_REMOVE;
        });
    }
});

webview.connect('load-failed', (view, loadEvent, uri, error) => {
    finish(false, '載入失敗: ' + uri + ' ' + error);
});

webview.load_uri(URL);

GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, OVERALL_TIMEOUT_SEC, () => {
    finish(false, '整體逾時 (' + OVERALL_TIMEOUT_SEC + ' 秒)');
    return GLib.SOURCE_REMOVE;
});

loop.run();
