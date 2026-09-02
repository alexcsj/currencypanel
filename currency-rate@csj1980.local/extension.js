import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const CURRENCY_ORDER = ['USD', 'JPY', 'CNY', 'EUR'];
const CURRENCY_NAMES = { USD: '美金', JPY: '日圓', CNY: '人民幣', EUR: '歐元' };
const AUTO_REFRESH_SECONDS = 3600;

export default class CurrencyRateExtension extends Extension {
    enable() {
        this._cacheDir = GLib.build_filenamev([GLib.get_home_dir(), '.cache', this.uuid]);
        this._ratesFile = Gio.File.new_for_path(GLib.build_filenamev([this._cacheDir, 'rates.json']));
        this._fetchScriptPath = GLib.build_filenamev([this.path, 'fetch-rate.js']);
        this._gjsPath = GLib.find_program_in_path('gjs') ?? 'gjs';

        this._refreshing = false;
        this._subprocess = null;
        this._autoTimeoutId = null;
        this._fileMonitor = null;

        this._indicator = new PanelMenu.Button(0.0, '台銀外幣匯率', false);

        this._label = new St.Label({
            text: '匯率讀取中…',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._indicator.add_child(this._label);

        this._currencyItems = {};
        for (const code of CURRENCY_ORDER) {
            const item = new PopupMenu.PopupMenuItem(`${CURRENCY_NAMES[code]} (${code})：--`, { reactive: false });
            this._currencyItems[code] = item;
            this._indicator.menu.addMenuItem(item);
        }

        this._updatedItem = new PopupMenu.PopupMenuItem('尚未更新', { reactive: false });
        this._indicator.menu.addMenuItem(this._updatedItem);

        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._refreshItem = new PopupMenu.PopupMenuItem('立即更新');
        this._refreshItem.connect('activate', () => this._refresh());
        this._indicator.menu.addMenuItem(this._refreshItem);

        Main.panel.addToStatusArea(this.uuid, this._indicator, 1, 'right');

        this._setupFileMonitor();
        this._loadAndRender();
        this._refresh();

        this._autoTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, AUTO_REFRESH_SECONDS, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _setupFileMonitor() {
        try {
            GLib.mkdir_with_parents(this._cacheDir, 0o700);
            this._fileMonitor = this._ratesFile.monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._fileMonitor.connect('changed', (monitor, file, otherFile, eventType) => {
                if (eventType === Gio.FileMonitorEvent.CHANGES_DONE_HINT
                    || eventType === Gio.FileMonitorEvent.CREATED) {
                    this._loadAndRender();
                }
            });
        } catch (e) {
            logError(e, 'currency-rate: 無法監看 rates.json');
        }
    }

    _loadAndRender() {
        this._ratesFile.load_contents_async(null, (file, result) => {
            let contents;
            try {
                [, contents] = file.load_contents_finish(result);
            } catch (e) {
                return; // 快取檔還不存在（例如第一次執行），保留目前畫面
            }
            try {
                const text = new TextDecoder('utf-8').decode(contents);
                const data = JSON.parse(text);
                this._render(data);
            } catch (e) {
                logError(e, 'currency-rate: 解析 rates.json 失敗');
            }
        });
    }

    _render(data) {
        const rates = data.rates ?? {};
        const parts = [];
        for (const code of CURRENCY_ORDER) {
            const value = rates[code];
            if (value) {
                parts.push(`${code} ${value}`);
                this._currencyItems[code].label.text = `${CURRENCY_NAMES[code]} (${code})：${value}`;
            } else {
                this._currencyItems[code].label.text = `${CURRENCY_NAMES[code]} (${code})：--`;
            }
        }
        this._label.text = parts.length > 0 ? parts.join('   ') : '匯率無法取得';

        if (data.updated) {
            const d = new Date(data.updated);
            const hh = String(d.getHours()).padStart(2, '0');
            const mm = String(d.getMinutes()).padStart(2, '0');
            this._updatedItem.label.text = `最後更新：${hh}:${mm}`;
        }
    }

    _refresh() {
        if (this._refreshing) return;
        this._refreshing = true;
        this._updatedItem.label.text = '更新中…';

        try {
            this._subprocess = Gio.Subprocess.new(
                [this._gjsPath, this._fetchScriptPath],
                Gio.SubprocessFlags.STDERR_PIPE
            );
            this._subprocess.communicate_utf8_async(null, null, (proc, result) => {
                this._refreshing = false;
                try {
                    const [, , stderr] = proc.communicate_utf8_finish(result);
                    if (!proc.get_successful() && stderr) {
                        logError(new Error(stderr), 'currency-rate: fetch-rate.js 執行失敗');
                        this._loadAndRender(); // 失敗時保留舊資料，只更新「最後更新」文字回舊值
                    }
                } catch (e) {
                    logError(e, 'currency-rate: 讀取子行程輸出失敗');
                } finally {
                    this._subprocess = null;
                }
            });
        } catch (e) {
            this._refreshing = false;
            logError(e, 'currency-rate: 無法啟動 fetch-rate.js');
        }
    }

    disable() {
        if (this._autoTimeoutId) {
            GLib.source_remove(this._autoTimeoutId);
            this._autoTimeoutId = null;
        }
        if (this._fileMonitor) {
            this._fileMonitor.cancel();
            this._fileMonitor = null;
        }
        if (this._subprocess) {
            try {
                this._subprocess.force_exit();
            } catch (e) {
                // 子行程可能已經結束
            }
            this._subprocess = null;
        }
        this._indicator?.destroy();
        this._indicator = null;
        this._currencyItems = null;
        this._label = null;
        this._updatedItem = null;
        this._refreshItem = null;
        this._ratesFile = null;
    }
}
