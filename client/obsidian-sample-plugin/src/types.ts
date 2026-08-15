export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

export interface RoomInfo {
	id: string;
	createdAt: number;
	description?: string;
	activePeers: number;
	docCount: number;
}

export interface CollabSettings {
	serverUrl: string;
	serverPassword?: string;
	adminPassword?: string;
	displayName: string;
	roomId: string;
	autoConnect: boolean;
	cursorColor: string;
	sharedFolder: string;
}

export const CURSOR_COLOR_PRESETS: { name: string; hex: string }[] = [
	{ name: 'Ocean Blue', hex: '#30bced' },
	{ name: 'Crimson Red', hex: '#e63946' },
	{ name: 'Teal Green', hex: '#2a9d8f' },
	{ name: 'Warm Amber', hex: '#f4a261' },
	{ name: 'Coral Orange', hex: '#e76f51' },
	{ name: 'Royal Purple', hex: '#9b5de5' },
	{ name: 'Hot Pink', hex: '#f15bb5' },
	{ name: 'Sky Blue', hex: '#00bbf9' },
	{ name: 'Mint Emerald', hex: '#00f5d4' },
	{ name: 'Magenta Rose', hex: '#ff006e' },
];

export function getRandomPresetColor(): string {
	const idx = Math.floor(Math.random() * CURSOR_COLOR_PRESETS.length);
	return CURSOR_COLOR_PRESETS[idx]!.hex;
}

export function getRandomUsername(): string {
	const randId = Math.floor(1000 + Math.random() * 9000);
	return `User ${randId}`;
}

export const DEFAULT_SETTINGS: CollabSettings = {
	serverUrl: 'ws://127.0.0.1:5612',
	serverPassword: 'changethispassword',
	adminPassword: '',
	displayName: 'Anonymous',
	roomId: 'vault-a',
	autoConnect: true,
	cursorColor: '#30bced',
	sharedFolder: '',
};

export interface FileCreateOp {
	type: 'create';
	path: string;
	content: string;
	binary?: boolean;
}

export interface FileModifyOp {
	type: 'modify';
	path: string;
	content: string;
	binary?: boolean;
}

export interface FileDeleteOp {
	type: 'delete';
	path: string;
}

export interface FileRenameOp {
	type: 'rename';
	oldPath: string;
	newPath: string;
}

export interface FileChunkStartOp {
	type: 'chunk-start';
	path: string;
	totalSize: number;
	binary?: boolean;
	transferId?: string;
}

export interface FileChunkDataOp {
	type: 'chunk-data';
	path: string;
	index: number;
	data: string;
	transferId?: string;
}

export interface FileChunkEndOp {
	type: 'chunk-end';
	path: string;
	transferId?: string;
}

export interface FileChunkResumeOp {
	type: 'chunk-resume';
	path: string;
	transferId: string;
	receivedSeqs: number[];
}

export interface FolderCreateOp {
	type: 'folder-create';
	path: string;
}

export type FileOp =
	| FileCreateOp
	| FileModifyOp
	| FileDeleteOp
	| FileRenameOp
	| FileChunkStartOp
	| FileChunkDataOp
	| FileChunkEndOp
	| FileChunkResumeOp
	| FolderCreateOp;

export interface FileOpMessage {
	type: 'file-op';
	op: FileOp;
}

export interface PresenceUpdateMessage {
	type: 'presence-update';
	displayName: string;
	activeFile: string | null;
}

export interface PingMessage {
	type: 'ping';
}

export interface PongMessage {
	type: 'pong';
}

export type ControlMessage =
	| FileOpMessage
	| PresenceUpdateMessage
	| PingMessage
	| PongMessage;

export interface FileEntry {
	hash: string;
	size: number;
	mtime: number;
	binary?: boolean;
	directory?: boolean;
}

export interface CursorUser {
	name: string;
	color: string;
}