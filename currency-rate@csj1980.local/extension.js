import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import { CheckBox } from 'resource:///org/gnome/shell/ui/checkBox.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const MAX_SELECTED = 4;
const DEFAULT_SELECTED = ['USD', 'JPY', 'CNY', 'EUR'];
const AUTO_REFRESH_SECONDS = 3600;

export default class CurrencyRateExtension extends Extension {
    enable() {
        this._cacheDir = GLib.build_filenamev([GLib.get_home_dir(), '.cache', this.uuid]);
        this._ratesFile = Gio.File.new_for_path(GLib.build_filenamev([this._cacheDir, 'rates.json']));
        this._configDir = GLib.build_filenamev([GLib.get_user_config_dir(), this.uuid]);
        this._fetchScriptPath = GLib.build_filenamev([this.path, 'fetch-rate.js']);
        this._gjsPath = GLib.find_program_in_path('gjs') ?? 'gjs';

        this._refreshing = false;
        this._subprocess = null;
        this._autoTimeoutId = null;
        this._fileMonitor = null;
        this._dialog = null;
        this._currencies = {}; // 最近一次抓到的完整幣別資料：{ CODE: { name, cashSell } }
        this._selected = this._loadSelected();
        this._expanded = true;

        this._indicator = new PanelMenu.Button(0.0, '台銀外幣匯率', true);

        const box = new St.BoxLayout({ style_class: 'currency-rate-box' });
        this._iconLabel = new St.Label({
            text: '$',
            style_class: 'currency-rate-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._label = new St.Label({
            text: '讀取中…',
            style_class: 'currency-rate-text',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._iconLabel);
        box.add_child(this._label);
        this._indicator.add_child(box);

        this._indicator.connect('button-press-event', (actor, event) => {
            const button = event.get_button();
            if (button === Clutter.BUTTON_PRIMARY) {
                this._toggleExpanded();
                return Clutter.EVENT_STOP;
            } else if (button === Clutter.BUTTON_SECONDARY) {
                this._openPicker();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        Main.panel.addToStatusArea(this.uuid, this._indicator, 1, 'right');

        this._setupFileMonitor();
        this._loadAndRender();
        this._refresh();

        this._autoTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, AUTO_REFRESH_SECONDS, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _toggleExpanded() {
        this._expanded = !this._expanded;
        this._label.visible = this._expanded;
    }

    _loadSelected() {
        try {
            const path = GLib.build_filenamev([this._configDir, 'selected.json']);
            const [, contents] = GLib.file_get_contents(path);
            const data = JSON.parse(new TextDecoder('utf-8').decode(contents));
            if (Array.isArray(data.selected) && data.selected.length > 0) {
                return data.selected.slice(0, MAX_SELECTED);
            }
        } catch (e) {
            // 設定檔還不存在，或格式不對，用預設幣別
        }
        return [...DEFAULT_SELECTED];
    }

    _saveSelected(codes) {
        try {
            GLib.mkdir_with_parents(this._configDir, 0o700);
            const path = GLib.build_filenamev([this._configDir, 'selected.json']);
            GLib.file_set_contents(path, JSON.stringify({ selected: codes }, null, 2));
        } catch (e) {
            logError(e, 'currency-rate: 無法儲存幣別選擇');
        }
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
                this._currencies = data.currencies ?? {};
                this._updateLabel();
            } catch (e) {
                logError(e, 'currency-rate: 解析 rates.json 失敗');
            }
        });
    }

    _updateLabel() {
        const parts = [];
        for (const code of this._selected) {
            const info = this._currencies[code];
            if (info && info.cashSell && info.cashSell !== '-') {
                parts.push(`${code} ${info.cashSell}`);
            }
        }
        this._label.text = parts.length > 0 ? parts.join('   ') : '尚無資料';
    }

    _refresh() {
        if (this._refreshing) return;
        this._refreshing = true;

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

    _openPicker() {
        if (this._dialog) return;

        const dialog = new ModalDialog.ModalDialog({ styleClass: 'currency-rate-dialog' });
        this._dialog = dialog;
        dialog.connect('destroy', () => {
            this._dialog = null;
        });

        const codes = Object.keys(this._currencies)
            .filter((code) => this._currencies[code].cashSell && this._currencies[code].cashSell !== '-')
            .sort();

        if (codes.length === 0) {
            dialog.contentLayout.add_child(new St.Label({
                text: '匯率資料尚未就緒，請稍後再試一次',
                style_class: 'currency-rate-dialog-hint',
            }));
            dialog.setButtons([
                { label: '關閉', action: () => dialog.close(), default: true },
            ]);
            dialog.open();
            return;
        }

        const hint = new St.Label({
            text: `請勾選要在面板顯示的幣別（最多 ${MAX_SELECTED} 個）`,
            style_class: 'currency-rate-dialog-hint',
        });
        dialog.contentLayout.add_child(hint);

        const counter = new St.Label({ style_class: 'currency-rate-dialog-counter' });
        dialog.contentLayout.add_child(counter);

        const scrollView = new St.ScrollView({
            style_class: 'currency-rate-dialog-scroll',
            x_expand: true,
            y_expand: true,
        });
        const list = new St.BoxLayout({ vertical: true, style_class: 'currency-rate-dialog-list' });
        scrollView.set_child(list);
        dialog.contentLayout.add_child(scrollView);

        const selectedSet = new Set(this._selected.filter((c) => codes.includes(c)));

        const updateCounter = (warn) => {
            counter.text = warn
                ? `最多只能勾選 ${MAX_SELECTED} 個`
                : `已選 ${selectedSet.size} / ${MAX_SELECTED}`;
            counter.style_class = warn
                ? 'currency-rate-dialog-counter currency-rate-dialog-counter-warn'
                : 'currency-rate-dialog-counter';
        };

        for (const code of codes) {
            const info = this._currencies[code];
            const checkbox = new CheckBox(`${info.name} (${code})　現金賣出 ${info.cashSell}`);
            checkbox.checked = selectedSet.has(code);
            checkbox.connect('clicked', () => {
                if (checkbox.checked && selectedSet.size >= MAX_SELECTED) {
                    checkbox.checked = false;
                    updateCounter(true);
                    return;
                }
                if (checkbox.checked) {
                    selectedSet.add(code);
                } else {
                    selectedSet.delete(code);
                }
                updateCounter(false);
            });
            list.add_child(checkbox);
        }

        updateCounter(false);

        dialog.setButtons([
            {
                label: '取消',
                action: () => dialog.close(),
                key: Clutter.KEY_Escape,
            },
            {
                label: '立即更新',
                action: () => {
                    this._refresh();
                    dialog.close();
                },
            },
            {
                label: '儲存',
                action: () => {
                    let newSelected = codes.filter((c) => selectedSet.has(c));
                    if (newSelected.length === 0) newSelected = [...DEFAULT_SELECTED];
                    this._selected = newSelected;
                    this._saveSelected(this._selected);
                    this._updateLabel();
                    dialog.close();
                },
                default: true,
            },
        ]);

        dialog.open();
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
        if (this._dialog) {
            this._dialog.close();
            this._dialog = null;
        }
        this._indicator?.destroy();
        this._indicator = null;
        this._iconLabel = null;
        this._label = null;
        this._ratesFile = null;
        this._currencies = null;
    }
}
