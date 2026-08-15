import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type CollabPlugin from './main';
import {
	CURSOR_COLOR_PRESETS,
	DEFAULT_SETTINGS,
	getRandomPresetColor,
	getRandomUsername,
	type RoomInfo,
} from './types';
import { toHttpUrl } from './utils';

export class CollabSettingTab extends PluginSettingTab {
	plugin: CollabPlugin;
	private isAdminUnlocked = false;
	private adminRooms: RoomInfo[] = [];
	private isLoadingRooms = false;
	private newRoomId = '';
	private newRoomDesc = '';

	constructor(app: App, plugin: CollabPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Synqra - Live Collaboration' });

		// --- Connection & Server Settings ---
		new Setting(containerEl)
			.setName('Server URL')
			.setDesc('WebSocket endpoint of the collab server, e.g. ws://127.0.0.1:5612 or https://collab.example.com')
			.addText((text) =>
				text
					.setPlaceholder('ws://127.0.0.1:5612')
					.setValue(this.plugin.settings.serverUrl)
					.onChange(async (value) => {
						this.plugin.settings.serverUrl = value.trim();
						await this.plugin.saveSettings();
						this.plugin.scheduleReconnect();
					}),
			);

		new Setting(containerEl)
			.setName('Server Password')
			.setDesc('Password required by the host to connect to this server.')
			.addText((text) => {
				text.inputEl.type = 'password';
				text
					.setPlaceholder('Server password')
					.setValue(this.plugin.settings.serverPassword ?? DEFAULT_SETTINGS.serverPassword ?? '')
					.onChange(async (value) => {
						this.plugin.settings.serverPassword = value;
						await this.plugin.saveSettings();
						this.plugin.scheduleReconnect();
					});
			})
			.addExtraButton((btn) => {
				btn.setIcon('eye')
					.setTooltip('Toggle password visibility')
					.onClick(() => {
						const input = containerEl.querySelector('input[placeholder="Server password"]') as HTMLInputElement | null;
						if (input) {
							input.type = input.type === 'password' ? 'text' : 'password';
						}
					});
			});

		new Setting(containerEl)
			.setName('Display name')
			.setDesc('The name other collaborators see for you.')
			.addText((text) =>
				text
					.setPlaceholder('User 1234')
					.setValue(this.plugin.settings.displayName)
					.onChange(async (value) => {
						this.plugin.settings.displayName = value.trim() || DEFAULT_SETTINGS.displayName;
						await this.plugin.saveSettings();
						this.plugin.scheduleReconnect();
					}),
			)
			.addButton((button) =>
				button
					.setButtonText('Randomize')
					.setTooltip('Randomize display name')
					.onClick(async () => {
						this.plugin.settings.displayName = getRandomUsername();
						await this.plugin.saveSettings();
						this.plugin.scheduleReconnect();
						this.display();
					}),
			);

		const colorSetting = new Setting(containerEl)
			.setName('Cursor color')
			.setDesc('Choose your cursor color from 10 preset colors.');

		colorSetting.addDropdown((dropdown) => {
			CURSOR_COLOR_PRESETS.forEach((preset) => {
				dropdown.addOption(preset.hex, `${preset.name} (${preset.hex})`);
			});
			if (!CURSOR_COLOR_PRESETS.some((p) => p.hex.toLowerCase() === this.plugin.settings.cursorColor.toLowerCase())) {
				dropdown.addOption(
					this.plugin.settings.cursorColor,
					`Custom (${this.plugin.settings.cursorColor})`,
				);
			}
			dropdown
				.setValue(this.plugin.settings.cursorColor)
				.onChange(async (value) => {
					this.plugin.settings.cursorColor = value;
					await this.plugin.saveSettings();
					this.plugin.scheduleReconnect();
				});
		});

		colorSetting.addButton((button) =>
			button
				.setButtonText('Randomize')
				.setTooltip('Pick a random preset color')
				.onClick(async () => {
					this.plugin.settings.cursorColor = getRandomPresetColor();
					await this.plugin.saveSettings();
					this.plugin.scheduleReconnect();
					this.display();
				}),
		);

		new Setting(containerEl)
			.setName('Room ID')
			.setDesc('The collaboration room ID provided by your server admin (e.g. vault-a).')
			.addText((text) =>
				text
					.setPlaceholder('vault-a')
					.setValue(this.plugin.settings.roomId)
					.onChange(async (value) => {
						this.plugin.settings.roomId = value.trim() || DEFAULT_SETTINGS.roomId;
						await this.plugin.saveSettings();
						this.plugin.scheduleReconnect();
					}),
			);

		new Setting(containerEl)
			.setName('Auto-connect on startup')
			.setDesc('Connect to the room automatically when Obsidian opens.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoConnect).onChange(async (value) => {
					this.plugin.settings.autoConnect = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Connection actions')
			.setDesc('Manually reconnect or force a full manifest sync.')
			.addButton((button) =>
				button.setButtonText('Reconnect now').onClick(() => {
					this.plugin.scheduleReconnect();
				}),
			)
			.addButton((button) =>
				button.setButtonText('Publish manifest').onClick(() => {
					void this.plugin.publishManifest();
				}),
			);

		// --- Admin Panel Section ---
		containerEl.createEl('hr', { cls: 'collab-divider' });
		containerEl.createEl('h3', { text: 'Server Admin Controls' });
		containerEl.createEl('p', {
			text: 'Enter the server Admin Password to create, manage, and delete collaboration rooms on this server.',
			cls: 'setting-item-description',
		});

		const adminSetting = new Setting(containerEl)
			.setName('Admin Password')
			.setDesc('Used exclusively for managing rooms on the host server.');

		adminSetting.addText((text) => {
			text.inputEl.type = 'password';
			text
				.setPlaceholder('Admin password')
				.setValue(this.plugin.settings.adminPassword ?? '')
				.onChange(async (value) => {
					this.plugin.settings.adminPassword = value;
					await this.plugin.saveSettings();
				});
		});

		adminSetting.addButton((btn) => {
			btn
				.setButtonText(this.isAdminUnlocked ? 'Refresh Rooms' : 'Unlock Admin Panel')
				.setCta()
				.onClick(async () => {
					await this.verifyAndLoadAdminRooms();
				});
		});

		if (this.isAdminUnlocked) {
			const adminBox = containerEl.createDiv({ cls: 'collab-admin-panel' });
			adminBox.createEl('h4', { text: 'Create New Room' });

			new Setting(adminBox)
				.setName('New Room ID')
				.setDesc('Unique room identifier (letters, numbers, dashes, underscores).')
				.addText((text) =>
					text
						.setPlaceholder('e.g. team-vault')
						.setValue(this.newRoomId)
						.onChange((val) => {
							this.newRoomId = val;
						}),
				)
				.addText((text) =>
					text
						.setPlaceholder('Optional description')
						.setValue(this.newRoomDesc)
						.onChange((val) => {
							this.newRoomDesc = val;
						}),
				)
				.addButton((btn) =>
					btn
						.setButtonText('Create Room')
						.setCta()
						.onClick(async () => {
							if (!this.newRoomId.trim()) {
								new Notice('Please enter a Room ID');
								return;
							}
							await this.createRoomOnServer(this.newRoomId.trim(), this.newRoomDesc.trim());
						}),
				);

			adminBox.createEl('h4', { text: 'Registered Rooms on Server' });

			if (this.isLoadingRooms) {
				adminBox.createEl('p', { text: 'Loading rooms from server...', cls: 'setting-item-description' });
			} else if (this.adminRooms.length === 0) {
				adminBox.createEl('p', { text: 'No rooms found on this server.', cls: 'setting-item-description' });
			} else {
				for (const room of this.adminRooms) {
					const isCurrentRoom = this.plugin.settings.roomId === room.id;
					const roomSetting = new Setting(adminBox)
						.setName(`${room.id} ${isCurrentRoom ? '(Active Room)' : ''}`)
						.setDesc(
							`Peers Online: ${room.activePeers} | Documents: ${room.docCount}${room.description ? ` | ${room.description}` : ''}`,
						);

					if (!isCurrentRoom) {
						roomSetting.addButton((btn) =>
							btn.setButtonText('Join Room').onClick(async () => {
								this.plugin.settings.roomId = room.id;
								await this.plugin.saveSettings();
								this.plugin.scheduleReconnect();
								new Notice(`Switched active room to '${room.id}'`);
								this.display();
							}),
						);
					}

					roomSetting.addButton((btn) =>
						btn
							.setButtonText('Delete Room')
							.setWarning()
							.onClick(async () => {
								const confirmed = confirm(
									`Are you sure you want to delete room '${room.id}' from the server?\n\nAll notes, history, and files in this room will be permanently erased.`,
								);
								if (confirmed) {
									await this.deleteRoomOnServer(room.id);
								}
							}),
					);
				}
			}
		}
	}

	private async verifyAndLoadAdminRooms(): Promise<void> {
		const adminPass = this.plugin.settings.adminPassword?.trim();
		if (!adminPass) {
			new Notice('Please enter the Admin Password first');
			return;
		}

		const httpUrl = toHttpUrl(this.plugin.settings.serverUrl);
		const sep = httpUrl.endsWith('/') ? '' : '/';

		try {
			this.isLoadingRooms = true;
			const verifyRes = await fetch(`${httpUrl}${sep}api/admin/verify`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${adminPass}`,
				},
				body: JSON.stringify({ adminPassword: adminPass }),
			});

			if (!verifyRes.ok) {
				this.isAdminUnlocked = false;
				new Notice('Admin verification failed: Invalid admin password');
				this.display();
				return;
			}

			this.isAdminUnlocked = true;
			await this.fetchRoomsList();
			new Notice('Admin controls unlocked successfully');
		} catch (err) {
			new Notice(`Failed to connect to server admin API: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this.isLoadingRooms = false;
			this.display();
		}
	}

	private async fetchRoomsList(): Promise<void> {
		const adminPass = this.plugin.settings.adminPassword?.trim() ?? '';
		const httpUrl = toHttpUrl(this.plugin.settings.serverUrl);
		const sep = httpUrl.endsWith('/') ? '' : '/';

		const res = await fetch(`${httpUrl}${sep}api/admin/rooms`, {
			headers: {
				Authorization: `Bearer ${adminPass}`,
			},
		});

		if (res.ok) {
			const data = (await res.json()) as { rooms: RoomInfo[] };
			this.adminRooms = data.rooms || [];
		} else {
			new Notice('Failed to load room list from server');
		}
	}

	private async createRoomOnServer(roomId: string, description: string): Promise<void> {
		const adminPass = this.plugin.settings.adminPassword?.trim() ?? '';
		const httpUrl = toHttpUrl(this.plugin.settings.serverUrl);
		const sep = httpUrl.endsWith('/') ? '' : '/';

		try {
			const res = await fetch(`${httpUrl}${sep}api/admin/rooms`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${adminPass}`,
				},
				body: JSON.stringify({ roomId, description }),
			});

			if (res.ok) {
				new Notice(`Room '${roomId}' created successfully!`);
				this.newRoomId = '';
				this.newRoomDesc = '';
				await this.fetchRoomsList();
				this.display();
			} else {
				const json = await res.json();
				new Notice(`Error creating room: ${json.error ?? 'Unknown error'}`);
			}
		} catch (err) {
			new Notice(`Error creating room: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async deleteRoomOnServer(roomId: string): Promise<void> {
		const adminPass = this.plugin.settings.adminPassword?.trim() ?? '';
		const httpUrl = toHttpUrl(this.plugin.settings.serverUrl);
		const sep = httpUrl.endsWith('/') ? '' : '/';

		try {
			const res = await fetch(`${httpUrl}${sep}api/admin/rooms/${encodeURIComponent(roomId)}`, {
				method: 'DELETE',
				headers: {
					Authorization: `Bearer ${adminPass}`,
				},
			});

			if (res.ok) {
				new Notice(`Room '${roomId}' deleted from server.`);
				if (this.plugin.settings.roomId === roomId) {
					this.plugin.settings.roomId = 'vault-a';
					await this.plugin.saveSettings();
					this.plugin.scheduleReconnect();
				}
				await this.fetchRoomsList();
				this.display();
			} else {
				const json = await res.json();
				new Notice(`Error deleting room: ${json.error ?? 'Unknown error'}`);
			}
		} catch (err) {
			new Notice(`Error deleting room: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}