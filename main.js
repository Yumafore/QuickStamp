'use strict';

const obsidian = require('obsidian');
const {
    Plugin, PluginSettingTab, Setting, MarkdownView, Notice, TFile, moment,
} = obsidian;

const DEFAULT_SETTINGS = {
    switchToDailyNote: true,
    useTemplate: false,
    templatePath: '',
    timestampFormat: 'HH:mm:ss',
    lockTimestamp: false,
    insertPosition: 'end',      // 'end' | 'heading'
    headingLevel: 2,            // 1-6
    headingText: '',            // 标题名（可选，包含匹配）
    headingDirection: 'after',  // 'before' | 'after'
    autoTimestampOnEnter: false,
};

const TS_PREFIX = '- ';
const TS_SUFFIX = ' ';

class AutoTimestampPlugin extends Plugin {
    async onload() {
        globalThis.__autoTimestampPlugin = this;
        await this.loadSettings();
        this.addSettingTab(new AutoTimestampSettingTab(this.app, this));

        // 回车自动插入：document 捕获阶段监听，抢在 CM6 / Obsidian 之前
        this.registerDomEvent(
            document,
            'keydown',
            (evt) => this.handleEnterKey(evt),
            true
        );

        this.addRibbonIcon('clock', '插入时间戳 / 模板', () => {
            this.handleInsert().catch((err) => {
                console.error('[Auto Timestamp]', err);
                new Notice('插入失败，详见控制台');
            });
        });

        this.addCommand({
            id: 'insert-timestamp',
            name: '插入时间戳 / 模板（今日日记）',
            icon: 'clock',
            callback: () => {
                this.handleInsert().catch((err) => {
                    console.error('[Auto Timestamp] handleInsert 失败:', err);
                    new Notice('插入失败，详见控制台');
                });
            },
        });
    }

    // ---------- 回车自动插入 ----------
    handleEnterKey(evt) {
        if (!this.settings.autoTimestampOnEnter) return;

        const isEnter = evt.key === 'Enter' || evt.keyCode === 13;
        if (!isEnter) return;

        if (evt.shiftKey || evt.ctrlKey || evt.metaKey || evt.altKey) return;
        if (evt.isComposing) return;

        const active = document.activeElement;
        if (!active || !active.closest('.cm-editor')) return;

        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || !view.editor) return;

        evt.preventDefault();
        evt.stopPropagation();

        const editor = view.editor;
        const ts = this.buildTimestampText();
        const cursor = editor.getCursor();

        editor.replaceRange('\n' + ts, cursor);

        const lines = ts.split('\n');
        editor.setCursor({
            line: cursor.line + lines.length,
            ch: lines[lines.length - 1].length,
        });
        editor.focus();
    }

    buildTimestampText() {
        const ts = moment().format(this.settings.timestampFormat || 'HH:mm:ss');
        return `${TS_PREFIX}${ts}${TS_SUFFIX}`;
    }

    // ---------- 按钮/命令触发 ----------
    async handleInsert() {
        let targetFile = null;
        let needSwitch = false;

        if (this.settings.switchToDailyNote) {
            const daily = this.getDailyNotes();
            if (!daily) {
                new Notice('未启用日记核心插件，仅在当前笔记操作');
            } else {
                try {
                    targetFile = await daily.createDailyNote(moment());
                    if (targetFile) {
                        const current = this.app.workspace.getActiveFile();
                        needSwitch = !current || current.path !== targetFile.path;
                    }
                } catch (err) {
                    console.error('[Auto Timestamp] 打开今日日记失败:', err);
                    new Notice('打开今日日记失败，仅在当前笔记操作');
                }
            }
        }

        if (needSwitch && targetFile) {
            const leaf = this.app.workspace.getLeaf(false);
            await leaf.openFile(targetFile);
            await new Promise((r) => setTimeout(r, 150));
        }

        if (this.settings.useTemplate) {
            await this.insertTemplate();
        } else {
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (view) {
                this.insertTextSmart(view.editor, this.buildTimestampText());
            } else {
                new Notice('当前没有打开的 Markdown 笔记');
            }
        }
    }

    // ---------- 按设置位置插入 ----------
    insertTextSmart(editor, text) {
        if (this.settings.insertPosition === 'heading') {
            const targetLine = this.findTargetHeadingLine(
                editor,
                this.settings.headingLevel,
                this.settings.headingText || ''
            );
            if (targetLine !== -1) {
                const insertLine = this.settings.headingDirection === 'before'
                    ? targetLine
                    : targetLine + 1;
                editor.replaceRange(text + '\n', { line: insertLine, ch: 0 });
                const lines = text.split('\n');
                editor.setCursor({
                    line: insertLine + lines.length - 1,
                    ch: lines[lines.length - 1].length,
                });
                this.finishInsert(editor);
                return;
            }
            const label = this.settings.headingText
                ? `H${this.settings.headingLevel} "${this.settings.headingText}"`
                : `H${this.settings.headingLevel}`;
            new Notice(`未找到标题 ${label}，回退到末尾插入`);
        }
        this.insertAtEnd(editor, text);
        this.finishInsert(editor);
    }

    insertAtEnd(editor, text) {
        const lastLine = editor.lineCount() - 1;
        const lastLineText = editor.getLine(lastLine);
        const lines = text.split('\n');
        if (lastLineText.trim() === '') {
            editor.replaceRange(text, { line: lastLine, ch: 0 });
            editor.setCursor({
                line: lastLine + lines.length - 1,
                ch: lines[lines.length - 1].length,
            });
        } else {
            editor.replaceRange('\n' + text, { line: lastLine, ch: lastLineText.length });
            editor.setCursor({
                line: lastLine + lines.length,
                ch: lines[lines.length - 1].length,
            });
        }
    }

    finishInsert(editor) {
        if (this.settings.lockTimestamp) {
            const cur = editor.getCursor();
            const lineText = editor.getLine(cur.line);
            editor.setCursor({ line: cur.line, ch: lineText.length });
        }
        editor.focus();
    }

    findTargetHeadingLine(editor, level, text) {
        const needle = (text || '').trim();
        const lineCount = editor.lineCount();
        for (let i = lineCount - 1; i >= 0; i--) {
            const line = editor.getLine(i);
            const m = line.match(/^(#{1,6})\s+(.*)$/);
            if (!m) continue;
            if (m[1].length !== level) continue;
            const title = m[2].trim();
            if (!needle || title.includes(needle)) {
                return i;
            }
        }
        return -1;
    }

    // ---------- 模板插入 ----------
    async insertTemplate() {
        const tp = this.getTemplater();
        const fallback = () => {
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (view) this.insertTextSmart(view.editor, this.buildTimestampText());
        };

        if (!tp) { new Notice('未启用 Templater，改为插入时间戳'); fallback(); return; }
        if (!this.settings.templatePath) { new Notice('未设置模板路径，改为插入时间戳'); fallback(); return; }

        const file = this.app.vault.getAbstractFileByPath(this.settings.templatePath);
        if (!(file instanceof TFile)) {
            new Notice('模板文件不存在: ' + this.settings.templatePath);
            return;
        }

        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) { new Notice('当前没有打开的 Markdown 笔记'); return; }
        const editor = view.editor;

        const rendered = await this.renderTemplateContent(file);
        if (typeof rendered === 'string') {
            this.insertTextSmart(editor, rendered);
            return;
        }

        try {
            await tp.append_template_to_active_file(file);
            setTimeout(() => {
                const v = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (v) v.editor.focus();
            }, 100);
        } catch (err) {
            console.error('[Auto Timestamp] 插入模板失败:', err);
            new Notice('插入模板失败，详见控制台');
        }
    }

    async renderTemplateContent(templateFile) {
        try {
            const tp = this.getTemplater();
            if (!tp || typeof tp.parse_template !== 'function') return null;
            const targetFile = this.app.workspace.getActiveFile();
            const result = await tp.parse_template({
                target_file: targetFile,
                template_file: templateFile,
            });
            return typeof result === 'string' ? result : null;
        } catch (e) {
            console.warn('[Auto Timestamp] renderTemplateContent 失败:', e);
            return null;
        }
    }

    // ---------- 外部插件访问 ----------
    getDailyNotes() {
        try {
            const p = this.app.internalPlugins?.getPluginById?.('daily-notes');
            return p?.enabled ? p.instance : null;
        } catch (_) { return null; }
    }

    getTemplater() {
        try {
            return this.app.plugins?.plugins?.['templater-obsidian']?.templater ?? null;
        } catch (_) { return null; }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }
    async saveSettings() {
        await this.saveData(this.settings);
    }
}

// ---------- 设置面板 ----------
class AutoTimestampSettingTab extends PluginSettingTab {
    constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Auto Timestamp 设置' });

        new Setting(containerEl)
            .setName('当前不是今日日记时，先打开今日日记')
            .addToggle((t) => t.setValue(this.plugin.settings.switchToDailyNote).onChange(async (v) => {
                this.plugin.settings.switchToDailyNote = v;
                await this.plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName('使用模板代替时间戳')
            .addToggle((t) => t.setValue(this.plugin.settings.useTemplate).onChange(async (v) => {
                this.plugin.settings.useTemplate = v;
                await this.plugin.saveSettings();
                this.display();
            }));

        if (this.plugin.settings.useTemplate) {
            new Setting(containerEl)
                .setName('模板文件路径')
                .setDesc('仓库相对路径，例如 templates/time.md（区分大小写，不带前导 /）')
                .addText((text) => text
                    .setPlaceholder('templates/time.md')
                    .setValue(this.plugin.settings.templatePath)
                    .onChange(async (v) => {
                        this.plugin.settings.templatePath = v.trim();
                        await this.plugin.saveSettings();
                    }));
        } else {
            new Setting(containerEl)
                .setName('时间戳格式')
                .setDesc('moment.js 格式。例：HH:mm:ss（24 小时制）、hh:mm:ss A（12 小时制）。插入的最终文本为 "- <时间戳> "。')
                .addText((text) => text
                    .setPlaceholder('HH:mm:ss')
                    .setValue(this.plugin.settings.timestampFormat)
                    .onChange(async (v) => {
                        this.plugin.settings.timestampFormat = v.trim() || 'HH:mm:ss';
                        await this.plugin.saveSettings();
                    }));
        }

        new Setting(containerEl)
            .setName('回车时自动插入时间戳')
            .setDesc('开启后，在 Markdown 编辑器按 Enter 会在新行插入 "- HH:mm:ss "。Shift/Ctrl/Cmd/Alt+Enter 仍为普通换行。')
            .addToggle((t) => t.setValue(this.plugin.settings.autoTimestampOnEnter).onChange(async (v) => {
                this.plugin.settings.autoTimestampOnEnter = v;
                await this.plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName('插入位置')
            .setDesc('点击按钮/命令时使用的位置，不影响"回车自动插入"。')
            .addDropdown((dd) => dd
                .addOption('end', '文章最后一行')
                .addOption('heading', '指定标题')
                .setValue(this.plugin.settings.insertPosition)
                .onChange(async (v) => {
                    this.plugin.settings.insertPosition = v;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        if (this.plugin.settings.insertPosition === 'heading') {
            new Setting(containerEl)
                .setName('标题层级')
                .addDropdown((dd) => {
                    for (let i = 1; i <= 6; i++) dd.addOption(String(i), `H${i}`);
                    return dd
                        .setValue(String(this.plugin.settings.headingLevel))
                        .onChange(async (v) => {
                            this.plugin.settings.headingLevel = parseInt(v, 10);
                            await this.plugin.saveSettings();
                        });
                });

            new Setting(containerEl)
                .setName('标题名（可选）')
                .setDesc('留空则匹配文中最后一个该层级标题；填写则只匹配"标题名包含该文本"的标题。例：任务 / 记录。')
                .addText((text) => text
                    .setPlaceholder('例如：任务')
                    .setValue(this.plugin.settings.headingText)
                    .onChange(async (v) => {
                        this.plugin.settings.headingText = v.trim();
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('插入方向')
                .addDropdown((dd) => dd
                    .addOption('before', '标题之前')
                    .addOption('after', '标题之后')
                    .setValue(this.plugin.settings.headingDirection)
                    .onChange(async (v) => {
                        this.plugin.settings.headingDirection = v;
                        await this.plugin.saveSettings();
                    }));
        }

        new Setting(containerEl)
            .setName('锁定时间戳（仅跳转光标）')
            .setDesc('开启后插入内容时光标自动跳到该行行尾，降低误编辑概率（稳定基线实现，无视觉样式）。')
            .addToggle((t) => t.setValue(this.plugin.settings.lockTimestamp).onChange(async (v) => {
                this.plugin.settings.lockTimestamp = v;
                await this.plugin.saveSettings();
            }));
    }
}

module.exports = AutoTimestampPlugin;