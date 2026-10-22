import { App, Modal, Setting } from 'obsidian';
import { SetupCheckResult } from '../sync/SetupCheck';
import { ExtrasPolicy, SetupDecision, Winner, isDecided, isDestructive, planFor } from '../sync/SetupPlan';
import { ConfirmModal } from './ConfirmModal';

export type SetupOutcome = SetupDecision | 'cancel';
export interface SetupModalOptions {
	primaryLabel: string;
	cancelNote: string;
	repositoryLabel?: string;
	localPath?: (path: string) => string;
}

/** First connection has no common baseline: show paths before asking which copy to use. */
export class SetupCheckModal extends Modal {
	private resolved = false;
	private winner: Winner | null = null;
	private extras: ExtrasPolicy = 'keep';
	private primaryButton: HTMLButtonElement | null = null;
	private decisionNote: HTMLElement | null = null;
	constructor(app: App, private result: SetupCheckResult, private options: SetupModalOptions,
		private onDecision: (outcome: SetupOutcome) => void) { super(app); }

	onOpen(): void {
		const { contentEl, result } = this;
		contentEl.empty();
		this.modalEl.addClass('ultisync-setup-modal');
		this.titleEl.setText('Проверка перед включением обмена');
		if (this.options.repositoryLabel) contentEl.createEl('p', {
			cls: 'ultisync-setup-repository', text: 'Репозиторий: ' + this.options.repositoryLabel,
		});
		contentEl.createEl('p', {
text: result.conflicting.length ?
				'Это не ошибка подключения. Обнаружены разные версии файлов; выберите, какую использовать. Пока вы не подтвердите выбор, файлы не изменятся.' :
				'Подключение проверено. Ниже перечислены различия и действия, которые будут выполнены после подтверждения.'
});
		this.renderFileLists();
		if (!result.conflicting.length && !this.hasExtras()) contentEl.createEl('p', { text: 'Все файлы совпадают. Можно включить обмен без замены файлов.' });
		if (result.relation === 'remote-empty') contentEl.createEl('p', { text: `GitHub пока пуст. Локальные файлы будут загружены в репозиторий: ${result.localOnly.length}.` });
		if (result.conflicting.length) this.renderWinnerChoice();
		if (this.hasExtras() && result.relation !== 'remote-empty') this.renderExtrasChoice();
		this.decisionNote = contentEl.createEl('p', { cls: 'ultisync-setup-decision', attr: { 'aria-live': 'polite' } });
		new Setting(contentEl).setClass('ultisync-setup-actions')
			.addButton(button => button.setButtonText('Отмена').onClick(() => this.decide('cancel')))
			.addButton(button => {
				this.primaryButton = button.buttonEl;
				button.setButtonText(this.options.primaryLabel).onClick(() => this.submit());
			});
		this.refreshPrimary();
		contentEl.createEl('p', { cls: 'setting-item-description', text: this.options.cancelNote });
	}
	private hasExtras(): boolean { return this.result.localOnly.length > 0 || this.result.remoteOnly.length > 0; }
	private path(path: string): string { return this.options.localPath?.(path) ?? path; }

	private renderWinnerChoice(): void {
		const row = new Setting(this.contentEl).setName('Какая версия заменит другую?')
			.setDesc('Выбор относится только к файлам из списка «Разные версии».');
		row.addDropdown(dropdown => dropdown
			.addOption('', 'Выберите источник…')
			.addOption('local', 'Локальная → GitHub')
			.addOption('remote', 'GitHub → локальная')
			.setValue('')
			.onChange(value => {
				this.winner = value === 'local' || value === 'remote' ? value : null;
				row.setDesc(this.winner === 'local' ?
					'Файлы на GitHub будут заменены локальными версиями. Прежние версии останутся в истории GitHub.' : this.winner === 'remote' ?
						'Локальные файлы будут заменены версиями GitHub. Прежние локальные копии сначала переместятся в корзину Obsidian.' :
						'Выбор относится только к файлам из списка «Разные версии».');
				this.refreshPrimary();
			}));
	}
	private renderExtrasChoice(): void {
		const { localOnly, remoteOnly } = this.result;
		const description = (policy: ExtrasPolicy): string => policy === 'local-only' ?
			`Будут удалены с GitHub файлы, отсутствующие локально: ${remoteOnly.length}.` : policy === 'remote-only' ?
				`Будут перемещены в корзину локальные файлы, отсутствующие на GitHub: ${localOnly.length}.` :
				`Новые файлы: отправить на GitHub — ${localOnly.length}; скачать с GitHub — ${remoteOnly.length}. Без удалений. Это не решает различия версий выше.`;
		const row = new Setting(this.contentEl).setName('Файлы, которые есть только с одной стороны').setDesc(description('keep'));
		row.addDropdown(dropdown => {
			dropdown.addOption('keep', 'Добавить недостающие, без удалений');
			if (remoteOnly.length) dropdown.addOption('local-only', 'Удалить лишние на GitHub');
			if (localOnly.length) dropdown.addOption('remote-only', 'Убрать лишние локальные в корзину');
			dropdown.setValue('keep').onChange(value => {
				if (value !== 'keep' && value !== 'local-only' && value !== 'remote-only') return;
				this.extras = value; row.setDesc(description(value)); this.refreshPrimary();
			});
		});
	}
	private decision(): SetupDecision { return { winner: this.winner, extras: this.extras }; }
	private refreshPrimary(): void {
		const button = this.primaryButton;
		if (!button) return;
		const decision = this.decision(), ready = isDecided(this.result, decision);
		button.disabled = !ready;
		const destructive = ready && isDestructive(planFor(this.result, decision));
		button.toggleClass('mod-warning', destructive); button.toggleClass('mod-cta', !destructive);
		if (!ready) { this.decisionNote?.setText('Сначала выберите источник для файлов с разными версиями.'); return; }
		const plan = planFor(this.result, decision);
		this.decisionNote?.setText(`После подтверждения: отправить — ${plan.upload.length}; скачать — ${plan.pull.length}; заменить локальные — ${plan.overwriteLocal.length}; в корзину — ${plan.trashLocal.length}; удалить с GitHub — ${plan.deleteRemote.length}.`);
	}
	private submit(): void {
		const decision = this.decision();
		if (!isDecided(this.result, decision)) return;
		const plan = planFor(this.result, decision);
		if (!isDestructive(plan)) { this.decide(decision); return; }
		const body: string[] = [], list: string[] = [];
		if (plan.deleteRemote.length) { body.push(`Удалить с GitHub: ${plan.deleteRemote.length}.`); list.push(...plan.deleteRemote.map(path => 'GitHub: ' + path)); }
		if (plan.trashLocal.length) { body.push(`Переместить локальные файлы в корзину: ${plan.trashLocal.length}.`); list.push(...plan.trashLocal.map(path => 'Локально: ' + this.path(path))); }
		if (plan.overwriteLocal.length) { body.push(`Заменить локальные файлы версиями GitHub: ${plan.overwriteLocal.length}. Прежние локальные копии сначала переместятся в корзину.`); list.push(...plan.overwriteLocal.map(path => 'Заменить: ' + this.path(path))); }
		body.push('Корзина определяется настройкой Obsidian в Files and links. Удалённые версии GitHub остаются в истории репозитория.');
		new ConfirmModal(this.app, { title: 'Подтвердите замены и удаления', body, list, confirmLabel: 'Применить изменения', cancelLabel: 'Отмена' }, confirmed => { if (confirmed) this.decide(decision); }).open();
	}
	private renderFileLists(): void {
		const groups: [string, string[], boolean][] = [
			['Разные версии', this.result.conflicting, true], ['Только на GitHub', this.result.remoteOnly, false], ['Только локально', this.result.localOnly, true],
		];
		for (const [label, paths, local] of groups) {
			if (!paths.length) continue;
			const details = this.contentEl.createEl('details', { cls: 'ultisync-file-list' });
			details.open = paths.length <= 10;
			details.createEl('summary', { text: `${label}: ${paths.length}` });
			const list = details.createEl('ul');
			for (const path of paths.slice(0, 50)) {
				const full = local ? this.path(path) : path;
				list.createEl('li', { text: local && full !== path ? `${full} → GitHub: ${path}` : full });
			}
			if (paths.length > 50) list.createEl('li', { text: `Ещё файлов: ${paths.length - 50}.` });
		}
	}
	private decide(outcome: SetupOutcome): void { if (this.resolved) return; this.resolved = true; this.close(); this.onDecision(outcome); }
	onClose(): void { this.contentEl.empty(); if (!this.resolved) { this.resolved = true; this.onDecision('cancel'); } }
}
