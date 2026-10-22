import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
class Element {
	children = []; text = ''; attrs = {}; classes = new Set(); disabled = false;
	constructor(tag = 'div', options = {}) { this.tag = tag; this.text = options.text ?? ''; }
	addEventListener() { }
	empty() { this.children = []; }
	addClass(name) { this.classes.add(name); }
	toggleClass(name, on) { on ? this.classes.add(name) : this.classes.delete(name); }
	setText(text) { this.text = text; }
	createEl(tag, options = {}) { const child = new Element(tag, options); this.children.push(child); return child; }
	createDiv(options = {}) { return this.createEl('div', options); }
	setAttribute(key, value) { this.attrs[key] = value; }
}
const rows = [], opened = [];
class Modal {
	constructor(app) { this.app = app; this.contentEl = new Element(); this.titleEl = new Element(); this.modalEl = new Element(); }
	open() { opened.push(this); this.onOpen(); }
	close() { this.onClose(); }
}
class Setting {
	constructor(parent) { this.settingEl = parent.createDiv(); this.nameEl = this.settingEl.createDiv(); this.descEl = this.settingEl.createDiv(); this.dropdowns = []; this.buttons = []; rows.push(this); }
	setName(name) { this.name = name; this.nameEl.setText(name); return this; }
	setDesc(text) { this.descEl.setText(text); return this; }
	setClass(name) { this.settingEl.addClass(name); return this; }
	addDropdown(configure) { const dropdown = { options: {}, addOption(k, v) { this.options[k] = v; return this; }, setValue(value) { this.value = value; return this; }, onChange(fn) { this.change = fn; return this; } }; this.dropdowns.push(dropdown); configure(dropdown); return this; }
	addButton(configure) { const button = { buttonEl: new Element('button'), setButtonText(text) { this.text = text; return this; }, onClick(fn) { this.click = fn; return this; }, setCta() { return this; }, setDestructive() { return this; } }; this.buttons.push(button); configure(button); return this; }
}
const bundle = await build({ entryPoints: ['src/ui/SetupCheckModal.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian'], logLevel: 'silent' });
const context = { module: { exports: {} }, exports: {}, require: () => ({ Modal, Setting }) }; runInNewContext(bundle.outputFiles[0].text, context);
const { SetupCheckModal } = context.module.exports;
function open() { rows.length = 0; opened.length = 0; const outcomes = []; const modal = new SetupCheckModal({}, { relation: 'diverged', commitSha: 'abc', localOnly: ['test.md'], remoteOnly: [], conflicting: ['profile.md'], identical: {}, localCount: 2, remoteCount: 1, bytesHashed: 0 }, { primaryLabel: 'Включить обмен', cancelNote: 'Отмена ничего не меняет.', repositoryLabel: 'example/context', localPath: path => 'GPT/' + path }, outcome => outcomes.push(outcome)); modal.open(); return { modal, outcomes }; }
function all(el) { return [el, ...el.children.flatMap(all)]; }
it('shows actual paths before native choices, with file groups expanded', () => {
	const { modal } = open(); const elements = all(modal.contentEl); assert.ok(elements.some(el => el.text.includes('example/context'))); assert.ok(elements.some(el => el.text.includes('GPT/profile.md'))); assert.ok(elements.filter(el => el.tag === 'details').every(el => el.open)); assert.equal(rows.flatMap(row => row.dropdowns).length, 2); assert.ok(modal.contentEl.children.indexOf(modal.contentEl.children.find(el => el.tag === 'details')) < modal.contentEl.children.indexOf(rows.find(row => row.dropdowns.length).settingEl));
});
it('requires an explicit winner and keeps nonconflicting extras by default', () => {
	const { outcomes } = open(); const primary = rows.flatMap(row => row.buttons).find(b => b.text === 'Включить обмен'); assert.equal(primary.buttonEl.disabled, true); const [winner, extras] = rows.flatMap(row => row.dropdowns); assert.equal(winner.value, ''); assert.equal(extras.value, 'keep'); winner.change('local'); assert.equal(primary.buttonEl.disabled, false); primary.click(); assert.equal(outcomes.length, 1); assert.equal(outcomes[0].winner, 'local'); assert.equal(outcomes[0].extras, 'keep');
});
it('requires confirmation before replacing local files and cancels without a plan', () => {
	const { modal, outcomes } = open(); rows.flatMap(row => row.dropdowns)[0].change('remote'); rows.flatMap(row => row.buttons).find(b => b.text === 'Включить обмен').click(); assert.equal(outcomes.length, 0); assert.equal(opened.length, 2); assert.ok(all(opened[1].contentEl).some(el => el.text.includes('GPT/profile.md'))); modal.close(); assert.deepEqual(outcomes, ['cancel']);
});
