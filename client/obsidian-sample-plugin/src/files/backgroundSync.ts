import { Notice, type Vault } from 'obsidian';
import type * as Y from 'yjs';
import type { SyncManager } from '../syncManager';
import {
	VAULT_EVENT_SETTLE_MS,
	applyMinimalYTextUpdate,
	ensureFolder,
	getFileByPath,
	isTextFile,
	normalizeLineEndings,
	normalizePath,
	toCanonicalPath,
	toLocalPath,
} from '../utils';
import type { FileOpsManager } from './fileOpsManager';
import type { ManifestManager } from './manifestManager';

const DEBOUNCE_MS = 1000;

export class BackgroundSync {
	private observers = new Map<string, () => void>();
	private subscribing = new Set<string>();
	private writeTimers = new Map<string, number>();
	private activeFile: string | null = null;
	private collabBoundFile: string | null = null;
	private recentDiskWrites = new Map<string, number>();
	private lastWrittenContent = new Map<string, string>();
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(
		private readonly vault: Vault,
		private readonly syncManager: SyncManager,
		private readonly manifestManager: ManifestManager,
		private readonly fileOpsManager: FileOpsManager,
	) {}

	async startAll(): Promise<void> {
		const entries = this.manifestManager.getEntries();
		for (const [path, entry] of entries) {
			if (!isTextFile(path) || entry.binary) continue;
			try {
				await this.subscribe(path);
			} catch {
				new Notice(`[Synqra] failed to sync ${path}`);
			}
		}
	}

	async subscribe(rawPath: string): Promise<void> {
		const path = toCanonicalPath(normalizePath(rawPath));
		if (!this.manifestManager.hasFile(path)) return;
		if (this.observers.has(path) || this.subscribing.has(path)) return;
		this.subscribing.add(path);

		try {
			const docHandle = this.syncManager.getDoc(path);
			if (!docHandle) return;

			try {
				await this.syncManager.waitForSync(path);
			} catch {
				return;
			}

			if (this.observers.has(path)) return;

			const diskPath = toLocalPath(path);
			const file = getFileByPath(this.vault, diskPath);
			const remoteContent = docHandle.text.toString();
			if (file) {
				const localContent = normalizeLineEndings(await this.vault.read(file));
				if (remoteContent !== localContent) {
					if (remoteContent.length === 0 && localContent.length > 0) {
						applyMinimalYTextUpdate(docHandle.doc, docHandle.text, localContent);
						this.lastWrittenContent.set(path, localContent);
					} else {
						await this.writeToDisk(path, remoteContent);
					}
				} else {
					this.lastWrittenContent.set(path, localContent);
				}
			}

			this.attachObserver(path, docHandle.text);
		} finally {
			this.subscribing.delete(path);
		}
	}

	setActiveFile(rawPath: string | null): void {
		const path = rawPath ? toCanonicalPath(normalizePath(rawPath)) : null;
		const oldActive = this.activeFile;
		this.activeFile = path;

		if (oldActive && oldActive !== path) {
			if (this.manifestManager.hasFile(oldActive)) {
				const diskPath = toLocalPath(oldActive);
				const file = getFileByPath(this.vault, diskPath);
				if (file) {
					const docHandle = this.syncManager.getDoc(oldActive);
					if (docHandle) {
						const content = docHandle.text.toString();
						void this.writeToDisk(oldActive, content);
						void this.manifestManager.updateFile(file, content);
					}
				}
			}
		}
	}

	setCollabBoundFile(path: string | null): void {
		this.collabBoundFile = path ? toCanonicalPath(normalizePath(path)) : null;
	}

	async onFileAdded(rawPath: string): Promise<void> {
		const path = toCanonicalPath(normalizePath(rawPath));
		if (!isTextFile(path)) return;
		await this.subscribe(path);
	}

	onFileRemoved(rawPath: string): void {
		const path = toCanonicalPath(normalizePath(rawPath));
		const prefix = path + '/';
		
		const remove = (p: string) => {
			const timer = this.writeTimers.get(p);
			if (timer) {
				window.clearTimeout(timer);
				this.writeTimers.delete(p);
			}
			const unobserve = this.observers.get(p);
			if (unobserve) {
				unobserve();
				this.observers.delete(p);
			}
			this.syncManager.releaseDoc(p);
		};

		remove(path);
		for (const p of this.observers.keys()) {
			if (p.startsWith(prefix)) {
				remove(p);
			}
		}
	}

	async onFileRenamed(oldPath: string, newPath: string): Promise<void> {
		const normOld = toCanonicalPath(normalizePath(oldPath));
		const normNew = toCanonicalPath(normalizePath(newPath));

		this.onFileRemoved(normOld);
		if (this.activeFile === normOld) {
			this.activeFile = normNew;
		}

		if (isTextFile(normNew)) {
			await this.subscribe(normNew);
		}
	}

	async handleLocalTextModify(rawPath: string): Promise<void> {
		const path = toCanonicalPath(normalizePath(rawPath));
		if (!this.manifestManager.hasFile(path)) return;
		if (this.isRecentDiskWrite(path)) return;
		if (path === this.collabBoundFile) return;

		const docHandle = this.syncManager.getDoc(path);
		if (!docHandle) return;

		const file = getFileByPath(this.vault, toLocalPath(path));
		if (!file) return;

		const localContent = normalizeLineEndings(await this.vault.read(file));
		if (localContent === this.lastWrittenContent.get(path)) return;
		if (localContent === docHandle.text.toString()) return;

		this.lastWrittenContent.set(path, localContent);
		applyMinimalYTextUpdate(docHandle.doc, docHandle.text, localContent);
		await this.manifestManager.updateFile(file, localContent);
	}

	isRecentDiskWrite(rawPath: string): boolean {
		const path = toCanonicalPath(normalizePath(rawPath));
		const until = this.recentDiskWrites.get(path);
		if (!until) return false;
		if (Date.now() > until) {
			this.recentDiskWrites.delete(path);
			return false;
		}
		return true;
	}

	destroy(): void {
		for (const path of [...this.writeTimers.keys()]) {
			this.flushWrite(path);
		}
		for (const [, unobserve] of this.observers) {
			unobserve();
		}
		this.observers.clear();
		this.activeFile = null;
		this.collabBoundFile = null;
		this.recentDiskWrites.clear();
		this.lastWrittenContent.clear();
	}

	private attachObserver(path: string, text: Y.Text): void {
		const observer = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
			if (transaction.local) return;
			if (path === this.collabBoundFile) return;
			this.scheduleDiskWrite(path, text);
		};
		text.observe(observer);
		this.observers.set(path, () => text.unobserve(observer));
	}

	private flushWrite(path: string): void {
		const timer = this.writeTimers.get(path);
		if (!timer) return;
		window.clearTimeout(timer);
		this.writeTimers.delete(path);
		const docHandle = this.syncManager.getDoc(path);
		if (docHandle) {
			void this.writeToDisk(path, docHandle.text.toString());
		}
	}

	private scheduleDiskWrite(path: string, text: Y.Text): void {
		const existing = this.writeTimers.get(path);
		if (existing) window.clearTimeout(existing);
		this.writeTimers.set(
			path,
			window.setTimeout(() => {
				this.writeTimers.delete(path);
				if (!this.manifestManager.hasFile(path)) return; // Do not write if deleted
				void this.writeToDisk(path, text.toString());
			}, DEBOUNCE_MS),
		);
	}

	private writeToDisk(path: string, content: string): Promise<void> {
		if (!this.manifestManager.hasFile(path)) return Promise.resolve();
		if (this.lastWrittenContent.get(path) === content) return Promise.resolve();
		this.writeQueue = this.writeQueue.then(() => this.doWriteToDisk(path, content));
		return this.writeQueue;
	}

	private async doWriteToDisk(path: string, content: string): Promise<void> {
		if (!this.manifestManager.hasFile(path)) return;
		if (this.lastWrittenContent.get(path) === content) return;
		const diskPath = toLocalPath(path);
		this.recentDiskWrites.set(path, Date.now() + VAULT_EVENT_SETTLE_MS);
		this.fileOpsManager.mutePathEvents(diskPath);
		try {
			const file = getFileByPath(this.vault, diskPath);
			if (file) {
				const existing = normalizeLineEndings(await this.vault.read(file));
				if (existing === content) {
					this.lastWrittenContent.set(path, content);
					return;
				}
			}
			const parentDir = diskPath.substring(0, diskPath.lastIndexOf('/'));
			if (parentDir) await ensureFolder(this.vault, parentDir);
			await this.vault.adapter.write(diskPath, content);
			this.lastWrittenContent.set(path, content);
		} catch {
			new Notice(`[Synqra] failed to write ${diskPath}`);
		} finally {
			window.setTimeout(() => {
				if (Date.now() >= (this.recentDiskWrites.get(path) ?? 0)) {
					this.recentDiskWrites.delete(path);
				}
				this.fileOpsManager.unmutePathEvents(diskPath);
			}, VAULT_EVENT_SETTLE_MS);
		}
	}
}
