import { Notice, TFolder, type TFile, type Vault } from 'obsidian';
import type * as Y from 'yjs';
import type { DocHandle, SyncManager } from '../syncManager';
import type { FileEntry } from '../types';
import {
	VAULT_EVENT_SETTLE_MS,
	ensureFolder,
	getFileByPath,
	isTextFile,
	normalizeLineEndings,
	normalizePath,
	toCanonicalPath,
	toHttpUrl,
	toLocalPath,
} from '../utils';
import type { ExclusionManager } from './exclusionManager';

async function hashBuffer(buf: ArrayBuffer): Promise<string> {
	const hash = await crypto.subtle.digest('SHA-256', buf);
	return Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

function hashContent(content: string): Promise<string> {
	return hashBuffer(new TextEncoder().encode(content).buffer);
}

export class ManifestManager {
	private syncManager: SyncManager | null = null;
	private docHandle: DocHandle | null = null;
	private manifest: Y.Map<FileEntry> | null = null;
	private observer: ((events: Y.YMapEvent<FileEntry>) => void) | null = null;

	constructor(
		private readonly vault: Vault,
		private readonly exclusionManager: ExclusionManager,
	) {}

	async connect(syncManager: SyncManager): Promise<void> {
		this.syncManager = syncManager;
		this.docHandle = syncManager.getDoc('__manifest__');
		if (!this.docHandle) return;
		this.manifest = this.docHandle.doc.getMap('files');
		await syncManager.waitForSync('__manifest__');
	}

	async publishManifest(): Promise<void> {
		if (!this.manifest || !this.docHandle) return;

		const files = this.getSharedFiles();
		const entries = new Map<string, FileEntry>();

		for (const file of files) {
			try {
				const binary = !isTextFile(file.path);
				const canonicalPath = toCanonicalPath(normalizePath(file.path));
				if (binary) {
					const binaryContent = await this.vault.readBinary(file);
					entries.set(canonicalPath, {
						hash: await hashBuffer(binaryContent),
						size: file.stat.size,
						mtime: file.stat.mtime,
						binary: true,
					});
				} else {
					const content = normalizeLineEndings(await this.vault.read(file));
					entries.set(canonicalPath, {
						hash: await hashContent(content),
						size: content.length,
						mtime: file.stat.mtime,
					});
				}
			} catch {
				new Notice(`[Synqra] failed to read ${file.path}, skipping`);
			}
		}

		for (const item of this.vault.getAllLoadedFiles()) {
			if (!(item instanceof TFolder)) continue;
			if (!item.path || item.path === '/') continue;
			if (!this.isSharedPath(item.path)) continue;
			if (item.children.length > 0) continue;
			entries.set(toCanonicalPath(normalizePath(item.path)), {
				hash: '',
				size: 0,
				mtime: 0,
				directory: true,
			});
		}

		this.docHandle.doc.transact(() => {
			for (const [filePath, fileEntry] of entries) {
				const existing = this.manifest?.get(filePath);
				if (existing && existing.hash === fileEntry.hash) continue;
				this.manifest?.set(filePath, fileEntry);
			}
		});
	}

	async purgeUnmatchedLocalFiles(
		fileManager: { trashFile: (file: any) => Promise<void> },
		workspace?: { iterateAllLeaves: (fn: (leaf: any) => void) => void },
		mute?: (path: string) => void,
		unmute?: (path: string) => void,
	): Promise<number> {
		if (!this.manifest) return 0;
		const entries = new Set(this.manifest.keys());
		let purged = 0;

		const allLocal = this.vault.getAllLoadedFiles();

		// Detach all workspace leaves for any unmatched files/folders first
		if (workspace) {
			for (const item of allLocal) {
				if (!item.path || item.path === '/') continue;
				if (!this.isSharedPath(item.path)) continue;
				const canonical = toCanonicalPath(normalizePath(item.path));
				if (!entries.has(canonical)) {
					const prefix = item.path.endsWith('/') ? item.path : item.path + '/';
					workspace.iterateAllLeaves((leaf: any) => {
						const p = leaf.view?.file?.path;
						if (p && (p === item.path || p.startsWith(prefix))) {
							leaf.detach();
						}
					});
				}
			}
		}

		// Separate files and folders to delete files first
		const filesToPurge: any[] = [];
		const foldersToPurge: any[] = [];

		for (const item of allLocal) {
			if (!item.path || item.path === '/') continue;
			if (!this.isSharedPath(item.path)) continue;
			const canonical = toCanonicalPath(normalizePath(item.path));
			if (!entries.has(canonical)) {
				if (item instanceof TFolder) {
					foldersToPurge.push(item);
				} else {
					filesToPurge.push(item);
				}
			}
		}

		for (const item of filesToPurge) {
			mute?.(item.path);
			try {
				await this.vault.delete(item, true);
				purged++;
			} catch {} finally {
				if (unmute) setTimeout(() => unmute(item.path), VAULT_EVENT_SETTLE_MS * 2);
			}
		}

		for (const item of foldersToPurge) {
			mute?.(item.path);
			try {
				await this.vault.delete(item, true);
				purged++;
			} catch {} finally {
				if (unmute) setTimeout(() => unmute(item.path), VAULT_EVENT_SETTLE_MS * 2);
			}
		}

		return purged;
	}

	async syncFromManifest(
		serverUrl: string,
		roomId: string,
		mute?: (path: string) => void,
		unmute?: (path: string) => void,
		serverPassword?: string,
	): Promise<number> {
		if (!this.manifest || !this.syncManager) return 0;

		let synced = 0;
		const entries = Array.from(this.manifest.entries());

		for (const [path, entry] of entries) {
			if (!path || path.startsWith('/') || path.startsWith('\\')) continue;
			const diskPath = toLocalPath(path);

			if (entry.directory) {
				const existing = this.vault.getAbstractFileByPath(diskPath);
				if (!existing) {
					await ensureFolder(this.vault, diskPath);
					synced++;
				}
				continue;
			}

			const localFile = getFileByPath(this.vault, diskPath);
			let needsSync = false;

			if (!localFile) {
				needsSync = true;
			} else if (entry.binary) {
				const binaryContent = await this.vault.readBinary(localFile);
				if ((await hashBuffer(binaryContent)) !== entry.hash) {
					needsSync = true;
				}
			} else {
				const content = normalizeLineEndings(await this.vault.read(localFile));
				if ((await hashContent(content)) !== entry.hash) {
					needsSync = true;
				}
			}

			if (!needsSync) continue;

			if (entry.binary) {
				try {
					const httpUrl = toHttpUrl(serverUrl);
					const sep = httpUrl.endsWith('/') ? '' : '/';
					const passParam = serverPassword ? `?password=${encodeURIComponent(serverPassword)}` : '';
					const fileUrl = `${httpUrl}${sep}file/${encodeURIComponent(roomId)}/${encodeURI(path)}${passParam}`;
					const res = await fetch(fileUrl);
					if (res.ok) {
						const arrayBuf = await res.arrayBuffer();
						const parentDir = diskPath.substring(0, diskPath.lastIndexOf('/'));
						if (parentDir) await ensureFolder(this.vault, parentDir);

						mute?.(diskPath);
						try {
							if (localFile) {
								await this.vault.modifyBinary(localFile, arrayBuf);
							} else {
								await this.vault.createBinary(diskPath, arrayBuf);
							}
						} finally {
							if (unmute) setTimeout(() => unmute(diskPath), VAULT_EVENT_SETTLE_MS);
						}
						synced++;
					}
				} catch {
					// Binary download failed
				}
				continue;
			}

			const tempHandle = this.syncManager.getDoc(path);
			if (!tempHandle) continue;

			try {
				await this.syncManager.waitForSync(path);
				const content = tempHandle.text.toString();
				const parentDir = diskPath.substring(0, diskPath.lastIndexOf('/'));
				if (parentDir) await ensureFolder(this.vault, parentDir);

				mute?.(diskPath);
				try {
					if (localFile) {
						await this.vault.modify(localFile, content);
					} else {
						await this.vault.create(diskPath, content);
					}
				} finally {
					if (unmute) {
						setTimeout(() => unmute(diskPath), VAULT_EVENT_SETTLE_MS);
					}
				}
				synced++;
			} catch {
				// Failed individual file sync
			}
		}

		return synced;
	}

	setManifestChangeHandler(
		callback: (added: string[], removed: string[], updated: string[]) => void,
	): void {
		if (!this.manifest) return;
		if (this.observer) this.manifest.unobserve(this.observer);

		this.observer = (event: Y.YMapEvent<FileEntry>) => {
			const added: string[] = [];
			const removed: string[] = [];
			const updated: string[] = [];
			event.changes.keys.forEach((change, key) => {
				if (change.action === 'add') added.push(key);
				else if (change.action === 'delete') removed.push(key);
				else if (change.action === 'update') updated.push(key);
			});
			if (added.length > 0 || removed.length > 0 || updated.length > 0) {
				callback(added, removed, updated);
			}
		};
		this.manifest.observe(this.observer);
	}

	async updateFile(file: TFile, content: string | ArrayBuffer): Promise<void> {
		if (!this.manifest || !this.isSharedPath(file.path)) return;
		const canonical = toCanonicalPath(normalizePath(file.path));

		if (content instanceof ArrayBuffer) {
			this.manifest.set(canonical, {
				hash: await hashBuffer(content),
				size: content.byteLength,
				mtime: file.stat.mtime,
				binary: true,
			});
		} else {
			const normalized = normalizeLineEndings(content);
			this.manifest.set(canonical, {
				hash: await hashContent(normalized),
				size: normalized.length,
				mtime: file.stat.mtime,
			});
		}
	}

	removeFile(path: string): void {
		if (!this.manifest) return;
		const canonical = toCanonicalPath(normalizePath(path));
		const prefix = canonical + '/';
		
		this.docHandle?.doc.transact(() => {
			this.manifest?.delete(canonical);
			if (this.manifest) {
				for (const key of this.manifest.keys()) {
					if (key.startsWith(prefix)) {
						this.manifest.delete(key);
					}
				}
			}
		});
	}

	hasFile(rawPath: string): boolean {
		if (!this.manifest) return false;
		return this.manifest.has(toCanonicalPath(normalizePath(rawPath)));
	}

	addFolder(rawPath: string): void {
		if (!this.manifest || !this.isSharedPath(rawPath)) return;
		const path = toCanonicalPath(normalizePath(rawPath));
		if (this.manifest.has(path)) return;
		this.manifest.set(path, { hash: '', size: 0, mtime: 0, directory: true });
	}

	renameFile(oldPath: string, newPath: string, syncManager?: SyncManager): void {
		if (!this.manifest || !this.docHandle) return;
		const normOld = toCanonicalPath(normalizePath(oldPath));
		const normNew = toCanonicalPath(normalizePath(newPath));
		const fileEntry = this.manifest.get(normOld);
		if (fileEntry) {
			this.docHandle.doc.transact(() => {
				this.manifest?.delete(normOld);
				this.manifest?.set(normNew, fileEntry);
			});
		}
		if (syncManager) {
			syncManager.releaseDoc(normOld);
		}
	}

	getEntries(): Map<string, FileEntry> {
		if (!this.manifest) return new Map();
		return new Map(this.manifest.entries());
	}

	isSharedPath(rawPath: string): boolean {
		const path = toCanonicalPath(normalizePath(rawPath));
		return !this.exclusionManager.isExcluded(path);
	}

	destroy(): void {
		if (this.observer && this.manifest) {
			this.manifest.unobserve(this.observer);
			this.observer = null;
		}
		if (this.syncManager) {
			this.syncManager.releaseDoc('__manifest__');
		}
		this.docHandle = null;
		this.manifest = null;
		this.syncManager = null;
	}

	private getSharedFiles(): TFile[] {
		return this.vault.getFiles().filter((file) => this.isSharedPath(file.path));
	}
}
