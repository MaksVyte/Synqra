import { MarkdownView, Notice, type TAbstractFile, TFile } from 'obsidian';
import type CollabPlugin from '../main';
import { isTextFile } from '../utils';

export function registerVaultEvents(plugin: CollabPlugin): void {
	let pendingRename: Promise<void> | null = null;
	const renamedPaths = new Set<string>();

	const onActiveChange = () => {
		const run = () => {
			plugin.onActiveFileChange();
			plugin.presenceManager.debouncedBroadcastPresence();
		};
		if (pendingRename) {
			void pendingRename.then(run);
		} else {
			run();
		}
	};

	plugin.registerEvent(plugin.app.workspace.on('active-leaf-change', onActiveChange));
	plugin.registerEvent(plugin.app.workspace.on('file-open', onActiveChange));
	plugin.registerEvent(plugin.app.workspace.on('layout-change', onActiveChange));

	plugin.registerEvent(
		plugin.app.vault.on('create', (file: TAbstractFile) => {
			if (!plugin.isConnected()) return;
			const originalPath = file.path;
			if (!plugin.manifestManager.isSharedPath(originalPath)) return;
			if (renamedPaths.has(originalPath)) return;

			if (plugin.fileOpsManager.isPathMuted(originalPath)) return;

			void plugin.fileOpsManager.onFileCreate(file as TFile);

			if (file instanceof TFile) {
				void (async () => {
					try {
						if (plugin.fileOpsManager.isPathMuted(originalPath)) return;
						const content = isTextFile(originalPath)
							? await plugin.app.vault.read(file)
							: await plugin.app.vault.readBinary(file);
						if (renamedPaths.has(originalPath)) return;
						if (plugin.fileOpsManager.isPathMuted(originalPath)) return;
						if (isTextFile(originalPath)) {
							await plugin.backgroundSync.onFileAdded(originalPath);
						}
						if (renamedPaths.has(originalPath)) return;
						if (plugin.fileOpsManager.isPathMuted(originalPath)) return;
						await plugin.manifestManager.updateFile(file, content);
					} catch {
						if (!renamedPaths.has(originalPath)) {
							new Notice(`[Synqra] failed to update manifest for ${originalPath}`);
						}
					}
				})();
			} else {
				plugin.manifestManager.addFolder(originalPath);
			}
		}),
	);

	plugin.registerEvent(
		plugin.app.vault.on('delete', (file: TAbstractFile) => {
			if (!plugin.isConnected()) return;
			if (!plugin.manifestManager.isSharedPath(file.path)) return;
			if (plugin.fileOpsManager.isPathMuted(file.path)) return;

			const run = () => {
				// Detach any open leaves for this file or sub-files if folder to prevent resurrection
				const prefix = file.path.endsWith('/') ? file.path : file.path + '/';
				plugin.app.workspace.iterateAllLeaves((leaf) => {
					const view = leaf.view as any;
					const p = view?.file?.path;
					if (p && (p === file.path || p.startsWith(prefix))) {
						leaf.detach();
					}
				});

				plugin.backgroundSync.onFileRemoved(file.path);
				plugin.manifestManager.removeFile(file.path);
				plugin.fileOpsManager.onFileDelete(file.path);
			};
			if (pendingRename) {
				void pendingRename.then(run);
			} else {
				run();
			}
		}),
	);

	plugin.registerEvent(
		plugin.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
			if (!plugin.isConnected()) return;
			if (plugin.fileOpsManager.isPathMuted(file.path) || plugin.fileOpsManager.isPathMuted(oldPath)) return;

			const oldShared = plugin.manifestManager.isSharedPath(oldPath);
			const newShared = plugin.manifestManager.isSharedPath(file.path);

			if (!oldShared && !newShared) return;

			// If moved from unshared/trash into shared vault: treat as create
			if (!oldShared && newShared) {
				if (file instanceof TFile) {
					void plugin.fileOpsManager.onFileCreate(file);
					void (async () => {
						try {
							const content = isTextFile(file.path)
								? await plugin.app.vault.read(file)
								: await plugin.app.vault.readBinary(file);
							if (isTextFile(file.path)) {
								await plugin.backgroundSync.onFileAdded(file.path);
							}
							await plugin.manifestManager.updateFile(file, content);
						} catch {}
					})();
				}
				return;
			}

			// If moved from shared vault into unshared/trash: treat as delete
			if (oldShared && !newShared) {
				plugin.backgroundSync.onFileRemoved(oldPath);
				plugin.manifestManager.removeFile(oldPath);
				plugin.fileOpsManager.onFileDelete(oldPath);
				return;
			}

			// Both are shared paths: normal rename
			renamedPaths.add(oldPath);

			const prev = pendingRename ?? Promise.resolve();
			const task = prev.then(async () => {
				plugin.fileOpsManager.onFileRename(oldPath, file.path);
				await plugin.backgroundSync.onFileRenamed(oldPath, file.path);
				plugin.manifestManager.renameFile(oldPath, file.path, plugin.syncManager);

				const activeFile = plugin.app.workspace.getActiveViewOfType(MarkdownView)?.file;
				if (activeFile && (activeFile.path === file.path || activeFile.path === oldPath)) {
					plugin.onActiveFileChange();
				}
			});
			pendingRename = task.finally(() => {
				if (pendingRename === task) pendingRename = null;
				renamedPaths.delete(oldPath);
			});
		}),
	);

	plugin.registerEvent(
		plugin.app.vault.on('modify', (file: TAbstractFile) => {
			if (!plugin.isConnected()) return;
			if (!(file instanceof TFile) || !plugin.manifestManager.isSharedPath(file.path)) return;
			if (plugin.fileOpsManager.isPathMuted(file.path)) return;
			if (!plugin.manifestManager.hasFile(file.path)) return;

			if (isTextFile(file.path)) {
				if (plugin.backgroundSync.isRecentDiskWrite(file.path)) return;
				void plugin.backgroundSync.handleLocalTextModify(file.path);
				return;
			}
			
			void plugin.fileOpsManager.onFileModify(file);
			void (async () => {
				try {
					const buf = await plugin.app.vault.readBinary(file);
					await plugin.manifestManager.updateFile(file, buf);
				} catch {
					new Notice(`[Synqra] failed to update manifest for ${file.path}`);
				}
			})();
		}),
	);
}
