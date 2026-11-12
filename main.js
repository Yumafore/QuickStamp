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
    insertPosition: 'end',       // 'end' | 'heading' | 'text'
    headingLevel: 2,
    headingText: '',
    headingDirection: 'after',
    targetText: '',
    textDirection: 'after',
    autoTimestampOnEnter: false,
    autoCreateHeading: true,
};

const TS_PREFIX = '- ';
const TS_SUFFIX = '\n    ';   // 时间戳后换行 + 4 个空格（一个缩进）

class QuickStampPlugin extends Plugin {
    async onload() {
        globalThis.__quickstampPlugin = this;
        await this.loadSettings();
        this.addSettingTab(new QuickStampSettingTab(this.app, this));

        this.registerDomEvent(
            document,
            'keydown',
            (evt) => this.handleEnterKey(evt),
            true
        );

        this.addRibbonIcon('clock', 'QuickStamp：插入时间戳 / 模板', () => {
            this.handleInsert().catch((err) => {
                console.error('[QuickStamp]', err);
                new Notice('插入失败，详见控制台');
            });
        });

        this.addCommand({
            id: 'insert-timestamp',
            name: 'QuickStamp：插入时间戳 / 模板',
            icon: 'clock',
            callback: () => {
                this.handleInsert().catch((err) => {
                    console.error('[QuickStamp] handleInsert 失败:', err);
                    new Notice('插入失败，详见控制台');
                });
            },
        });
    }

    // ---------- 回车自动插入（固定光标处） ----------
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
        this.focusEditor(editor);
    }

    buildTimestampText() {
        const ts = moment().format(this.settings.timestampFormat || 'HH:mm:ss');
        return `${TS_PREFIX}${ts}${TS_SUFFIX}`;
    }

    // ---------- 主流程 ----------
    async handleInsert() {
        if (this.settings.switchToDailyNote) {
            await this.openTodayDailyNote();
        }

        if (this.settings.useTemplate) {
            await this.insertTemplate();
        } else {
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (view) {
                this.insertTextSmart(view, this.buildTimestampText());
            } else {
                new Notice('当前没有打开的 Markdown 笔记');
            }
        }
    }

    async openTodayDailyNote() {
        const dailyPlugin = this.app.internalPlugins?.getPluginById?.('daily-notes');
        if (!dailyPlugin?.enabled) {
            new Notice('未启用“日记”核心插件，仅在当前笔记操作');
            return false;
        }

        const beforeFile = this.app.workspace.getActiveFile();

        try {
            await this.app.commands.executeCommandById('daily-notes');
        } catch (err) {
            console.error('[QuickStamp] 执行 daily-notes 命令失败:', err);
            new Notice('打开今日日记失败，详见控制台');
            return false;
        }

        const afterFile = await this.waitForDailyNoteSwitch(beforeFile, 5, 200);
        if (!afterFile) {
            return !!this.app.workspace.getActiveViewOfType(MarkdownView);
        }

        this.warnIfTemplaterConflict(afterFile);
        return true;
    }

    async waitForDailyNoteSwitch(beforeFile, maxRetries, intervalMs) {
        for (let i = 0; i < maxRetries; i++) {
            await new Promise((r) => setTimeout(r, intervalMs));
            const current = this.app.workspace.getActiveFile();
            if (!current) continue;

            if (!beforeFile || current.path !== beforeFile.path) {
                if (this.isTodayDailyNote(current)) return current;
                return current;
            }

            if (this.isTodayDailyNote(current)) return current;
        }
        return null;
    }

    isTodayDailyNote(file) {
        if (!file) return false;
        try {
            const daily = this.app.internalPlugins?.getPluginById?.('daily-notes');
            if (!daily?.instance) return false;
            const format = daily.instance.getFormat
                ? daily.instance.getFormat()
                : daily.instance.options?.format || 'YYYY-MM-DD';
            const expectedName = moment().format(format);
            const basename = file.basename;
            return basename === expectedName || basename.includes(expectedName);
        } catch (_) {
            return false;
        }
    }

    warnIfTemplaterConflict(dailyFile) {
        try {
            const tp = this.app.plugins?.plugins?.['templater-obsidian'];
            if (!tp) return;
            const tpSettings = tp.settings;
            if (!tpSettings?.trigger_on_file_creation) return;

            const daily = this.app.internalPlugins?.getPluginById?.('daily-notes');
            const dailyTemplate = daily?.instance?.options?.template;
            if (dailyTemplate) {
                console.warn(
                    '[QuickStamp] 检测到 Templater 的“新文件创建时触发”已开启，' +
                    '同时 Daily Notes 也配置了模板，可能导致日记内容重复处理或异常。' +
                    '建议在 Templater 中关闭该选项，或调整 Folder Templates 避免覆盖日记文件夹。'
                );
            }
        } catch (_) { /* 忽略 */ }
    }

    // ---------- 统一插入逻辑（时间戳与模板共用） ----------
    insertTextSmart(view, text) {
        const editor = view.editor;

        const rawPosition = this.settings.insertPosition;
        const position = ['heading', 'end', 'text'].includes(rawPosition) ? rawPosition : 'end';

        // ===== 标题模式 =====
        if (position === 'heading') {
            const levelNum = this.normalizeLevel(this.settings.headingLevel);
            const direction = this.settings.headingDirection === 'before' ? 'before' : 'after';
            const needle = (this.settings.headingText || '').trim();

            console.log(
                `[QuickStamp] 插入 → 位置=heading, 层级=H${levelNum}, 方向=${direction}, 标题名="${needle || '(留空)'}", 自动创建=${this.settings.autoCreateHeading}`
            );

            const targetLine = this.findTargetHeadingLine(editor, levelNum, needle);
            if (targetLine !== -1) {
                this.insertAtHeading(editor, targetLine, direction, text);
                this.finishInsert(view);
                return;
            }

            if (this.settings.autoCreateHeading && needle) {
                console.log(
                    `[QuickStamp] 未找到标题，在文档末尾创建 H${levelNum} "${needle}"（方向=${direction}）并插入内容`
                );
                this.appendHeadingAndInsert(editor, levelNum, needle, text, direction);
                this.finishInsert(view);
                return;
            }

            const available = this.listHeadings(editor, levelNum);
            let hint;
            if (available.length === 0) {
                hint = `文档中没有 H${levelNum} 标题（注意 Markdown 标题需 # 后跟空格，例如「## 标题」）`;
            } else {
                const sample = available
                    .slice(0, 8)
                    .map((h) => `第${h.line + 1}行「${h.title}」`)
                    .join('、');
                const more = available.length > 8 ? ` 等 ${available.length} 个` : '';
                hint = `文档中 H${levelNum} 标题有：${sample}${more}`;
            }
            const reason = !this.settings.autoCreateHeading
                ? '「未找到标题时自动创建」开关已关闭'
                : '「标题名」留空，无法命名新标题';
            console.warn(
                `[QuickStamp] ❌ 未找到匹配标题（层级 H${levelNum}，标题名含「${needle || '(留空则任意)'}」）。${reason}。${hint}。已回退到文章末尾插入。`,
                available
            );

            this.insertAtEnd(editor, text);
            this.finishInsert(view);
            return;
        }

        // ===== 文本模式 =====
        if (position === 'text') {
            const targetText = (this.settings.targetText || '').trim();
            const direction = this.settings.textDirection === 'before' ? 'before' : 'after';

            if (!targetText) {
                console.warn('[QuickStamp] 文本模式但「目标文本」为空，回退到文章末尾插入');
                this.insertAtEnd(editor, text);
                this.finishInsert(view);
                return;
            }

            console.log(
                `[QuickStamp] 插入 → 位置=text, 目标文本="${targetText}", 方向=${direction}`
            );

            const targetLine = this.findTargetTextLine(editor, targetText);
            if (targetLine !== -1) {
                this.insertAtHeading(editor, targetLine, direction, text);
                this.finishInsert(view);
                return;
            }

            console.warn(
                `[QuickStamp] ❌ 未找到包含「${targetText}」的行，已回退到文章末尾插入。`
            );
            this.insertAtEnd(editor, text);
            this.finishInsert(view);
            return;
        }

        // ===== 末尾模式 =====
        this.insertAtEnd(editor, text);
        this.finishInsert(view);
    }

    appendHeadingAndInsert(editor, level, headingText, text, direction) {
        const headingLine = '#'.repeat(level) + ' ' + headingText;
        const lines = text.split('\n');
        const lastCh = lines[lines.length - 1].length;

        const lastLine = editor.lineCount() - 1;
        const lastLineText = editor.getLine(lastLine);
        const lastLineIsBlank = lastLineText.trim() === '';

        const insertAt = lastLineIsBlank
            ? { line: lastLine, ch: 0 }
            : { line: lastLine, ch: lastLineText.length };

        const prefixNewline = lastLineIsBlank ? '' : '\n';

        let payload;
        let cursorLine;

        if (direction === 'before') {
            payload = prefixNewline + text + '\n' + headingLine;
            cursorLine = lastLineIsBlank
                ? lastLine + lines.length - 1
                : lastLine + lines.length;
        } else {
            payload = prefixNewline + headingLine + '\n' + text;
            cursorLine = lastLineIsBlank
                ? lastLine + lines.length
                : lastLine + lines.length + 1;
        }

        editor.replaceRange(payload, insertAt);
        editor.setCursor({ line: cursorLine, ch: lastCh });
    }

    insertAtHeading(editor, targetLine, direction, text) {
        const lines = text.split('\n');
        const lastCh = lines[lines.length - 1].length;

        if (direction === 'before') {
            editor.replaceRange(text + '\n', { line: targetLine, ch: 0 });
            editor.setCursor({
                line: targetLine + lines.length - 1,
                ch: lastCh,
            });
            return;
        }

        // after
        const lineCount = editor.lineCount();
        if (targetLine + 1 >= lineCount) {
            const lastLineText = editor.getLine(targetLine);
            editor.replaceRange('\n' + text, { line: targetLine, ch: lastLineText.length });
            editor.setCursor({
                line: targetLine + lines.length,
                ch: lastCh,
            });
        } else {
            editor.replaceRange(text + '\n', { line: targetLine + 1, ch: 0 });
            editor.setCursor({
                line: targetLine + lines.length,
                ch: lastCh,
            });
        }
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

    finishInsert(view) {
        const editor = view.editor;
        this.focusEditor(editor);
    }

    normalizeLevel(level) {
        const n = parseInt(level, 10);
        if (Number.isNaN(n) || n < 1 || n > 6) return 2;
        return n;
    }

    // ============ 性能优化：一次性扫描全文 ============

    /**
     * 一次 getValue + split，扫描所有标题。
     * 替代原先逐行 getLine 的 O(n) 次调用。
     */
    listHeadings(editor, level) {
        const levelNum = this.normalizeLevel(level);
        const lines = editor.getValue().split('\n');
        const result = [];
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(/^\s*(#{1,6})\s+(.*)$/);
            if (!m) continue;
            if (m[1].length !== levelNum) continue;
            result.push({ line: i, title: m[2].trim(), raw: lines[i] });
        }
        return result;
    }

    findTargetHeadingLine(editor, level, needle) {
        const all = this.listHeadings(editor, level);
        for (let k = all.length - 1; k >= 0; k--) {
            const h = all[k];
            if (!needle || h.title.includes(needle)) {
                console.log(`[QuickStamp] ✅ 匹配标题：第 ${h.line + 1} 行「${h.raw}」`);
                return h.line;
            }
        }
        return -1;
    }

    /**
     * 一次 getValue + lastIndexOf，替代逐行 getLine。
     * lastIndexOf 是原生实现，极快；行号用 charCodeAt 计数，单次 O(n)。
     */
    findTargetTextLine(editor, needle) {
        const content = editor.getValue();
        const idx = content.lastIndexOf(needle);
        if (idx === -1) return -1;

        // 计算 needle 所在行号：数 idx 之前的 '\n' 个数
        // 用 charCodeAt（10 = '\n'），避免 split 创建大数组
        let line = 0;
        for (let i = 0; i < idx; i++) {
            if (content.charCodeAt(i) === 10) line++;
        }

        const lineText = content.slice(idx, content.indexOf('\n', idx) === -1 ? content.length : content.indexOf('\n', idx));
        console.log(`[QuickStamp] ✅ 匹配文本：第 ${line + 1} 行「${lineText.trim()}」`);
        return line;
    }

    focusEditor(editor) {
        try { editor.focus(); } catch (_) {}
    }

    // ---------- 模板插入（遵循插入位置设置） ----------
    async insertTemplate() {
        const tp = this.getTemplater();
        const fallback = () => {
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (view) this.insertTextSmart(view, this.buildTimestampText());
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

        const rendered = await this.renderTemplateContent(file);
        if (typeof rendered === 'string' && rendered.length > 0) {
            this.insertTextSmart(view, rendered);
        } else {
            new Notice('模板渲染/读取失败，已回退到时间戳插入');
            fallback();
        }
    }

    async renderTemplateContent(templateFile) {
        const tp = this.getTemplater();
        const targetFile = this.app.workspace.getActiveFile();

        if (tp && typeof tp.read_and_parse_template === 'function') {
            try {
                const result = await tp.read_and_parse_template({
                    target_file: targetFile,
                    template_file: templateFile,
                });
                if (typeof result === 'string') return result;
            } catch (e1) {
                try {
                    const result = await tp.read_and_parse_template(templateFile);
                    if (typeof result === 'string') return result;
                } catch (e2) {
                    console.warn('[QuickStamp] read_and_parse_template 失败:', e2);
                }
            }
        }

        try {
            const content = await this.app.vault.read(templateFile);
            console.warn('[QuickStamp] 模板未渲染，直接使用原文（Templater 语法不会被解析）');
            return content;
        } catch (e) {
            console.warn('[QuickStamp] 读取模板文件失败:', e);
            return null;
        }
    }

    getTemplater() {
        try {
            return this.app.plugins?.plugins?.['templater-obsidian']?.templater ?? null;
        } catch (_) { return null; }
    }

    async loadSettings() {
        const loaded = (await this.loadData()) || {};
        this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
        this.settings.headingLevel = this.normalizeLevel(this.settings.headingLevel);
        if (!['heading', 'end', 'text'].includes(this.settings.insertPosition)) {
            this.settings.insertPosition = 'end';
        }
        if (this.settings.headingDirection !== 'before' && this.settings.headingDirection !== 'after') {
            this.settings.headingDirection = 'after';
        }
        if (this.settings.textDirection !== 'before' && this.settings.textDirection !== 'after') {
            this.settings.textDirection = 'after';
        }
        this.settings.targetText = this.settings.targetText || '';
        console.log(
            `[QuickStamp] 启动设置：位置=${this.settings.insertPosition}, 层级=H${this.settings.headingLevel}, ` +
            `标题方向=${this.settings.headingDirection}, 标题名="${this.settings.headingText || ''}", ` +
            `目标文本="${this.settings.targetText || ''}", 文本方向=${this.settings.textDirection}, ` +
            `自动创建=${this.settings.autoCreateHeading}`
        );
    }
    async saveSettings() {
        await this.saveData(this.settings);
    }
}

// ---------- 设置面板 ----------
class QuickStampSettingTab extends PluginSettingTab {
    constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'QuickStamp 设置' });

        new Setting(containerEl)
            .setName('当前不是今日日记时，先打开今日日记')
            .addToggle((t) => t.setValue(this.plugin.settings.switchToDailyNote).onChange(async (v) => {
                this.plugin.settings.switchToDailyNote = v;
                await this.plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName('使用模板代替时间戳')
            .setDesc('开启后通过 Templater 插入并渲染模板。模板同样遵循下方"插入位置"设置。')
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
                .setDesc('moment.js 格式。例：HH:mm:ss（24 小时制）、hh:mm:ss A（12 小时制）。插入的最终文本为 "- <时间戳>" 后接换行和 4 个空格缩进，光标落在缩进末尾。')
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
            .setDesc('开启后，在 Markdown 编辑器按 Enter 会在新行插入 "- HH:mm:ss"（其后跟换行和 4 空格缩进）。回车插入始终发生在光标处，不受"插入位置"设置影响。')
            .addToggle((t) => t.setValue(this.plugin.settings.autoTimestampOnEnter).onChange(async (v) => {
                this.plugin.settings.autoTimestampOnEnter = v;
                await this.plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName('插入位置')
            .setDesc('对时间戳和模板都生效。可插入到文章末尾、指定标题附近，或指定文本附近。')
            .addDropdown((dd) => dd
                .addOption('end', '文章最后一行')
                .addOption('heading', '指定标题')
                .addOption('text', '指定文本')
                .setValue(this.plugin.settings.insertPosition)
                .onChange(async (v) => {
                    this.plugin.settings.insertPosition = v;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        // ===== 标题模式设置 =====
        if (this.plugin.settings.insertPosition === 'heading') {
            new Setting(containerEl)
                .setName('标题层级')
                .addDropdown((dd) => {
                    for (let i = 1; i <= 6; i++) dd.addOption(String(i), `H${i}`);
                    return dd
                        .setValue(String(this.plugin.settings.headingLevel))
                        .onChange(async (v) => {
                            this.plugin.settings.headingLevel = this.plugin.normalizeLevel(v);
                            await this.plugin.saveSettings();
                        });
                });

            new Setting(containerEl)
                .setName('标题名（可选）')
                .setDesc('留空则匹配文中最后一个该层级标题；填写则只匹配"标题名包含该文本"的标题（如填 "任务" 可匹配 "今日任务"）。')
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

            new Setting(containerEl)
                .setName('未找到标题时自动创建')
                .setDesc('仅在"标题名"非空时生效。开启后，若文档中不存在匹配标题，会在文档末尾新建 `## 标题名`，并按"插入方向"把内容插在其之前或之后。关闭后回退到文章末尾插入内容。')
                .addToggle((t) => t.setValue(this.plugin.settings.autoCreateHeading).onChange(async (v) => {
                    this.plugin.settings.autoCreateHeading = v;
                    await this.plugin.saveSettings();
                }));
        }

        // ===== 文本模式设置 =====
        if (this.plugin.settings.insertPosition === 'text') {
            new Setting(containerEl)
                .setName('目标文本')
                .setDesc('测试功能谨慎使用：要匹配的文本片段（区分大小写）。会从文末向上查找**最后一个包含该文本的行**作为锚点。使用全文一次性扫描，长文档也很快。')
                .addText((text) => text
                    .setPlaceholder('例如：今日总结')
                    .setValue(this.plugin.settings.targetText)
                    .onChange(async (v) => {
                        this.plugin.settings.targetText = v.trim();
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('插入方向')
                .addDropdown((dd) => dd
                    .addOption('before', '目标文本所在行之前')
                    .addOption('after', '目标文本所在行之后')
                    .setValue(this.plugin.settings.textDirection)
                    .onChange(async (v) => {
                        this.plugin.settings.textDirection = v;
                        await this.plugin.saveSettings();
                    }));

            const hint = containerEl.createEl('p', { text: '提示：找不到目标文本时，内容会插入到文章末尾。可在控制台查看匹配日志。' });
            hint.style.cssText = 'color: var(--text-muted); font-size: 12px; margin-top: -8px;';
        }
    }
}

module.exports = QuickStampPlugin;
