import { Platform, TFile, TFolder, type Vault } from 'obsidian';

export const VAULT_EVENT_SETTLE_MS = 250;

const WIN_CHAR_MAP: [string, string][] = [
	['?', '\uFF1F'],
	['*', '\u204E'],
	['<', '\uFF1C'],
	['>', '\uFF1E'],
	['"', '\uFF02'],
	['|', '\uFF5C'],
	[':', '\uFF1A'],
];

const ASCII_TO_FULLWIDTH = new Map(WIN_CHAR_MAP.map(([a, f]) => [a, f]));
const FULLWIDTH_TO_ASCII = new Map(WIN_CHAR_MAP.map(([a, f]) => [f, a]));

const FULLWIDTH_RE = new RegExp(`[${WIN_CHAR_MAP.map(([, f]) => f).join('')}]`, 'g');
const ASCII_RE = new RegExp(
	`[${WIN_CHAR_MAP.map(([a]) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('')}]`,
	'g',
);

export function toLocalPath(canonicalPath: string): string {
	if (!Platform.isWin) return canonicalPath;
	return canonicalPath.replace(ASCII_RE, (ch) => ASCII_TO_FULLWIDTH.get(ch) ?? ch);
}

export function toCanonicalPath(localPath: string): string {
	if (!Platform.isWin) return localPath;
	return localPath.replace(FULLWIDTH_RE, (ch) => FULLWIDTH_TO_ASCII.get(ch) ?? ch);
}

export function normalizePath(filePath: string): string {
	return filePath.replace(/\\/g, '/');
}

export function normalizeLineEndings(content: string): string {
	return content.replace(/\r\n|\r/g, '\n');
}

export function applyMinimalYTextUpdate(
	doc: { transact: (fn: () => void) => void },
	text: {
		toString: () => string;
		delete: (pos: number, len: number) => void;
		insert: (pos: number, s: string) => void;
		length: number;
	},
	newContent: string,
): void {
	const oldContent = text.toString();
	if (oldContent === newContent) return;

	let prefix = 0;
	const minLen = Math.min(oldContent.length, newContent.length);
	while (prefix < minLen && oldContent[prefix] === newContent[prefix]) prefix++;

	let oldSuffix = oldContent.length;
	let newSuffix = newContent.length;
	while (
		oldSuffix > prefix &&
		newSuffix > prefix &&
		oldContent[oldSuffix - 1] === newContent[newSuffix - 1]
	) {
		oldSuffix--;
		newSuffix--;
	}

	doc.transact(() => {
		if (oldSuffix > prefix) text.delete(prefix, oldSuffix - prefix);
		if (newSuffix > prefix) text.insert(prefix, newContent.slice(prefix, newSuffix));
	});
}

export function toWsUrl(httpUrl: string): string {
	if (httpUrl.startsWith('ws://') || httpUrl.startsWith('wss://')) {
		return httpUrl;
	}
	return httpUrl.replace(/^http/, 'ws');
}

export function toHttpUrl(wsUrl: string): string {
	if (wsUrl.startsWith('http://') || wsUrl.startsWith('https://')) {
		return wsUrl;
	}
	return wsUrl.replace(/^ws/, 'http');
}

const TEXT_EXTENSIONS = new Set([
	'md',
	'txt',
	'json',
	'css',
	'js',
	'ts',
	'jsx',
	'tsx',
	'html',
	'xml',
	'yaml',
	'yml',
	'csv',
	'svg',
	'tex',
	'latex',
	'canvas',
	'mermaid',
	'toml',
	'ini',
	'sh',
	'py',
	'excalidraw',
]);

export function isTextFile(path: string): boolean {
	const dot = path.lastIndexOf('.');
	if (dot < 0) return false;
	return TEXT_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

export function isExcalidrawFile(path: string): boolean {
	const lower = path.toLowerCase();
	return lower.endsWith('.excalidraw') || lower.endsWith('.excalidraw.md');
}

export function arrayBufferToBase64(buf: ArrayBuffer): string {
	let binary = '';
	const bytes = new Uint8Array(buf);
	const len = bytes.byteLength;
	const chunkSize = 0x8000; // 32KB chunks to prevent stack overflow
	for (let i = 0; i < len; i += chunkSize) {
		const chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
		binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
	}
	return btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
	const binary = atob(base64);
	const len = binary.length;
	const bytes = new Uint8Array(len);
	for (let i = 0; i < len; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer;
}

export function getFileByPath(vault: Vault, path: string): TFile | null {
	const file = vault.getAbstractFileByPath(path);
	return file instanceof TFile ? file : null;
}

export async function ensureFolder(vault: Vault, path: string): Promise<void> {
	const existing = vault.getAbstractFileByPath(path);
	if (existing instanceof TFolder) return;
	const parts = path.split('/');
	let current = '';
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		const folder = vault.getAbstractFileByPath(current);
		if (!folder) {
			try {
				await vault.createFolder(current);
			} catch {
				// Folder may already exist from a concurrent create
			}
		}
	}
}
