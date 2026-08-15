import { Notice, type App } from 'obsidian';
import type { ControlChannel } from '../sync/controlChannel';
import type { SyncManager } from '../syncManager';

export class PresenceManager {
	private debounceTimer: number | null = null;
	private peersMap = new Map<string, { displayName: string; activeFile: string | null }>();

	constructor(
		private readonly app: App,
		private readonly controlChannel: ControlChannel,
		private readonly syncManager: SyncManager,
		private readonly getDisplayName: () => string,
	) {
		this.controlChannel.onMessage((msg) => {
			if (msg.type === 'presence-update') {
				this.peersMap.set(msg.displayName, {
					displayName: msg.displayName,
					activeFile: msg.activeFile,
				});
			}
		});
	}

	debouncedBroadcastPresence(): void {
		if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
		this.debounceTimer = window.setTimeout(() => {
			this.debounceTimer = null;
			this.broadcastPresence();
		}, 500);
	}

	broadcastPresence(): void {
		const activeFile = this.app.workspace.getActiveFile()?.path ?? null;
		this.controlChannel.send({
			type: 'presence-update',
			displayName: this.getDisplayName(),
			activeFile,
		});
	}


	destroy(): void {
		if (this.debounceTimer !== null) {
			window.clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		this.peersMap.clear();
	}
}
