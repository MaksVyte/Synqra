import { Notice, Plugin, TFile } from 'obsidian';
import { CollabSettingTab } from './settings';
import { DEFAULT_SETTINGS, getRandomPresetColor, getRandomUsername, type CollabSettings, type ConnectionStatus } from './types';
import { SyncManager } from './syncManager';
import { ControlChannel } from './sync/controlChannel';
import { ExclusionManager } from './files/exclusionManager';
import { FileOpsManager } from './files/fileOpsManager';
import { ManifestManager } from './files/manifestManager';
import { BackgroundSync } from './files/backgroundSync';
import { EditorBinding } from './editorBinding';
import { ExcalidrawBinding } from './editor/excalidrawBinding';
import { PresenceManager } from './session/presenceManager';
import { registerVaultEvents } from './files/vaultEvents';
import { isTextFile, toLocalPath, VAULT_EVENT_SETTLE_MS } from './utils';

export default class CollabPlugin extends Plugin {
	settings!: CollabSettings;
	syncManager!: SyncManager;
	controlChannel!: ControlChannel;
	exclusionManager!: ExclusionManager;
	fileOpsManager!: FileOpsManager;
	manifestManager!: ManifestManager;
	backgroundSync!: BackgroundSync;
	editorBinding!: EditorBinding;
	excalidrawBinding!: ExcalidrawBinding;
	presenceManager!: PresenceManager;

	private statusBar: HTMLElement | null = null;
	private currentStatus: ConnectionStatus = 'disconnected';

	async onload(): Promise<void> {
		await this.loadSettings();

		this.syncManager = new SyncManager(() => ({
			serverUrl: this.settings.serverUrl,
			serverPassword: this.settings.serverPassword,
			displayName: this.settings.displayName,
			roomId: this.settings.roomId,
		}));

		this.controlChannel = new ControlChannel(() => this.settings);

		this.exclusionManager = new ExclusionManager();
		this.fileOpsManager = new FileOpsManager(this.app, this.app.vault, this.app.fileManager);
		this.manifestManager = new ManifestManager(this.app.vault, this.exclusionManager);
		this.backgroundSync = new BackgroundSync(
			this.app.vault,
			this.syncManager,
			this.manifestManager,
			this.fileOpsManager,
		);
		this.editorBinding = new EditorBinding(
			this.app,
			this.syncManager,
			(path) => this.manifestManager.hasFile(path),
		);
		this.excalidrawBinding = new ExcalidrawBinding(
			this.app,
			this.syncManager,
			(path) => this.manifestManager.hasFile(path),
		);
		this.presenceManager = new PresenceManager(
			this.app,
			this.controlChannel,
			this.syncManager,
			() => this.settings.displayName,
		);

		// Wire control channel file ops
		this.fileOpsManager.setSender((op) => {
			this.controlChannel.send({ type: 'file-op', op });
		});

		this.controlChannel.onMessage(async (msg) => {
			if (msg.type === 'file-op') {
				await this.fileOpsManager.applyRemoteOp(msg.op);
			}
		});

		// Register CM6 base extension
		this.registerEditorExtension(this.editorBinding.getBaseExtension());

		// Sync status updates
		this.syncManager.onStatus = (status: ConnectionStatus) => {
			this.currentStatus = status;
			this.updateStatusBar();
			if (status === 'connected') {
				void this.onConnected();
			}
		};

		this.controlChannel.onStatusChange = (status) => {
			if (status === 'connected') {
				this.presenceManager.broadcastPresence();
			}
		};

		// Vault and workspace event listeners
		registerVaultEvents(this);

		// Commands
		this.addCommand({
			id: 'connect',
			name: 'Connect to collaboration room',
			callback: () => this.connect(),
		});
		this.addCommand({
			id: 'disconnect',
			name: 'Disconnect from collaboration room',
			callback: () => this.disconnect(),
		});
		this.addCommand({
			id: 'reconnect',
			name: 'Reconnect to collaboration room',
			callback: () => this.scheduleReconnect(),
		});


		// Settings tab
		this.addSettingTab(new CollabSettingTab(this.app, this));

		// Status bar
		this.statusBar = this.addStatusBarItem();
		this.updateStatusBar();

		if (this.settings.autoConnect) {
			void this.connect();
		}
	}

	onunload(): void {
		this.excalidrawBinding.destroy();
		this.editorBinding.destroy();
		this.backgroundSync.destroy();
		this.manifestManager.destroy();
		this.fileOpsManager.destroy();
		this.presenceManager.destroy();
		this.controlChannel.destroy();
		this.syncManager.disconnect();
	}

	connect(): void {
		void this.syncManager.connect();
		this.controlChannel.connect();
	}

	disconnect(): void {
		this.syncManager.disconnect();
		this.controlChannel.disconnect();
	}

	scheduleReconnect(): void {
		this.disconnect();
		this.connect();
	}

	async publishManifest(): Promise<void> {
		if (this.currentStatus !== 'connected') {
			new Notice('[Synqra] please connect to room first');
			return;
		}
		await this.manifestManager.publishManifest();
		new Notice('[Synqra] vault manifest published');
	}

	onActiveFileChange(): void {
		const activeFile = this.app.workspace.getActiveFile();
		this.backgroundSync.setActiveFile(activeFile?.path ?? null);
		void (async () => {
			const cursorUser = {
				name: this.settings.displayName,
				color: this.settings.cursorColor,
			};

			const excalidrawBound = await this.excalidrawBinding.activateForFile(activeFile, cursorUser);
			if (excalidrawBound) {
				this.backgroundSync.setCollabBoundFile(activeFile?.path ?? null);
				return;
			}

			const editorBound = await this.editorBinding.activateForFile(activeFile, cursorUser);
			if (editorBound) {
				this.backgroundSync.setCollabBoundFile(activeFile?.path ?? null);
			} else {
				this.backgroundSync.setCollabBoundFile(null);
			}
		})();
	}

	async loadSettings(): Promise<void> {
		const raw = (await this.loadData()) as Partial<CollabSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);

		let needsSave = false;
		if (!raw || !raw.displayName || raw.displayName === 'Anonymous') {
			this.settings.displayName = getRandomUsername();
			needsSave = true;
		}
		if (!raw || !raw.cursorColor) {
			this.settings.cursorColor = getRandomPresetColor();
			needsSave = true;
		}

		if (needsSave) {
			await this.saveSettings();
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	isConnected(): boolean {
		return this.currentStatus === 'connected';
	}

	private async onConnected(): Promise<void> {
		try {
			await this.manifestManager.connect(this.syncManager);
			await this.manifestManager.purgeUnmatchedLocalFiles(
				this.app.fileManager,
				this.app.workspace,
				(path) => this.fileOpsManager.mutePathEvents(path),
				(path) => this.fileOpsManager.unmutePathEvents(path),
			);
			await this.manifestManager.syncFromManifest(
				this.settings.serverUrl,
				this.settings.roomId,
				(path) => this.fileOpsManager.mutePathEvents(path),
				(path) => this.fileOpsManager.unmutePathEvents(path),
				this.settings.serverPassword,
			);
			await this.backgroundSync.startAll();
			this.onActiveFileChange();

			this.manifestManager.setManifestChangeHandler(async (added, removed, _updated) => {
				for (const path of removed) {
					const localPath = toLocalPath(path);
					const prefix = localPath.endsWith('/') ? localPath : localPath + '/';
					this.app.workspace.iterateAllLeaves((leaf) => {
						const view = leaf.view as any;
						const p = view?.file?.path;
						if (p && (p === localPath || p.startsWith(prefix))) {
							leaf.detach();
						}
					});
					this.backgroundSync.onFileRemoved(path);
					const file = this.app.vault.getAbstractFileByPath(localPath);
					if (file) {
						this.fileOpsManager.mutePathEvents(localPath);
						try {
							await this.app.vault.delete(file, true);
						} catch {} finally {
							setTimeout(() => this.fileOpsManager.unmutePathEvents(localPath), VAULT_EVENT_SETTLE_MS);
						}
					}
				}
				for (const path of added) {
					if (isTextFile(path)) {
						await this.backgroundSync.onFileAdded(path);
					}
				}
			});
		} catch (err) {
			console.error('[Synqra] error during connect init:', err);
		}
	}

	private updateStatusBar(): void {
		if (!this.statusBar) return;
		const statusText =
			this.currentStatus === 'connected'
				? `Collab: on`
				: this.currentStatus === 'connecting'
					? 'Collab: connecting…'
					: 'Collab: off';
		this.statusBar.setText(statusText);
	}
}

export type { CollabSettings };