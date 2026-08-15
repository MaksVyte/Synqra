import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as Y from 'yjs';
import type { ConnectionStatus } from './types';
import {
	MUX_AWARENESS,
	MUX_SUBSCRIBE,
	MUX_SUBSCRIBED,
	MUX_SYNC,
	MUX_SYNC_REQUEST,
	MUX_UNSUBSCRIBE,
	decodeMuxMessage,
	encodeMuxMessage,
} from './muxProtocol';

import { Notice } from 'obsidian';
import { normalizePath, toHttpUrl, toWsUrl } from './utils';

const SYNC_STEP2 = 1;
const KEEPALIVE_MS = 20_000;
const RECONNECT_BASE_MS = 100;
const RECONNECT_MAX_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 15;

export interface DocHandle {
	doc: Y.Doc;
	text: Y.Text;
	awareness: awarenessProtocol.Awareness;
}

type SyncListener = (synced: boolean) => void;

/**
 * Per-file Yjs sync manager (faithful port of the reference SyncManager).
 *
 * Each note path gets its own Y.Doc + Y.Text("content") + Awareness, addressed
 * on one WebSocket via the mux protocol. The editor is bound to the per-file
 * doc/text through a CM6 Compartment.
 */
export class SyncManager {
	private docs = new Map<string, Y.Doc>();
	private awarenessMap = new Map<string, awarenessProtocol.Awareness>();
	private synced = new Map<string, boolean>();
	private syncListeners = new Map<string, Set<SyncListener>>();
	private updateHandlers = new Map<string, (update: Uint8Array, origin: unknown) => void>();
	private awarenessHandlers = new Map<
		string,
		(changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => void
	>();

	private ws: WebSocket | null = null;
	private isConnected = false;
	private shouldConnect = false;
	private reconnectAttempts = 0;
	private reconnectTimer: number | null = null;
	private keepaliveTimer: number | null = null;
	private generation = 0;

	onStatus: (status: ConnectionStatus) => void = () => {};
	private displayName = 'Anonymous';

	constructor(
		private readonly settings: () => {
			serverUrl: string;
			displayName: string;
			roomId: string;
			serverPassword?: string;
		},
	) {}

	/** Reconnect now with the latest settings (like reference scheduleReconnect). */
	scheduleReconnect(): void {
		this.disconnect();
		void this.connect();
	}

	async connect(): Promise<void> {
		const { serverUrl, roomId, displayName } = this.settings();
		if (!serverUrl || !roomId) return;
		this.displayName = displayName;
		this.shouldConnect = true;
		this.openWebSocket();
	}

	disconnect(): void {
		this.shouldConnect = false;
		this.isConnected = false;
		if (this.reconnectTimer !== null) {
			window.clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.keepaliveTimer !== null) {
			window.clearInterval(this.keepaliveTimer);
			this.keepaliveTimer = null;
		}
		if (this.ws) {
			const ws = this.ws;
			this.ws = null;
			try {
				ws.close();
			} catch {
				// Ignore close error
			}
		}
		this.onStatus('disconnected');
		for (const filePath of this.docs.keys()) {
			this.setSynced(filePath, false);
		}
	}

	/** Get/create the per-file doc handle (subscribes when connected). */
	getDoc(filePath: string): DocHandle | null {
		const normPath = normalizePath(filePath);
		let doc = this.docs.get(normPath);
		if (!doc) {
			doc = new Y.Doc({ gc: false });
			const awareness = new awarenessProtocol.Awareness(doc);
			this.docs.set(normPath, doc);
			this.awarenessMap.set(normPath, awareness);
			this.synced.set(normPath, false);

			const updateHandler = (update: Uint8Array, origin: unknown) => {
				if (origin === 'sync' || origin === 'remote') return;
				const syncEncoder = encoding.createEncoder();
				syncProtocol.writeUpdate(syncEncoder, update);
				this.sendMux(normPath, MUX_SYNC, encoding.toUint8Array(syncEncoder));
			};
			doc.on('update', updateHandler);
			this.updateHandlers.set(normPath, updateHandler);

			const awarenessHandler = (
				changes: { added: number[]; updated: number[]; removed: number[] },
				origin: unknown,
			) => {
				if (origin === 'remote') return;
				const changedClients = changes.added.concat(changes.updated, changes.removed);
				const encoded = awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients);
				this.sendMux(normPath, MUX_AWARENESS, encoded);
			};
			awareness.on('update', awarenessHandler);
			this.awarenessHandlers.set(normPath, awarenessHandler);

			if (this.isConnected) {
				this.sendMux(normPath, MUX_SUBSCRIBE);
			}
		}
		const text = doc.getText('content');
		const awareness = this.awarenessMap.get(normPath)!;
		return { doc, text, awareness };
	}

	releaseDoc(filePath: string): void {
		const normPath = normalizePath(filePath);
		const doc = this.docs.get(normPath);
		if (!doc) return;

		const updateHandler = this.updateHandlers.get(normPath);
		if (updateHandler) {
			doc.off('update', updateHandler);
			this.updateHandlers.delete(normPath);
		}

		const awareness = this.awarenessMap.get(normPath);
		if (awareness) {
			const awarenessHandler = this.awarenessHandlers.get(normPath);
			if (awarenessHandler) {
				awareness.off('update', awarenessHandler);
				this.awarenessHandlers.delete(normPath);
			}
			awareness.destroy();
			this.awarenessMap.delete(normPath);
		}

		if (this.isConnected) {
			this.sendMux(normPath, MUX_UNSUBSCRIBE);
		}

		doc.destroy();
		this.docs.delete(normPath);
		this.synced.delete(normPath);
		this.syncListeners.delete(normPath);
	}

	/** Resolve once the per-file doc has received the server's full state. */
	async waitForSync(filePath: string, timeoutMs = 10000): Promise<void> {
		const normPath = normalizePath(filePath);
		if (this.synced.get(normPath)) return;

		return new Promise<void>((resolve, reject) => {
			const timer = window.setTimeout(() => {
				listeners?.delete(listener);
				reject(new Error(`sync timeout for ${normPath}`));
			}, timeoutMs);

			const listener: SyncListener = (isSynced) => {
				if (isSynced) {
					window.clearTimeout(timer);
					listeners?.delete(listener);
					resolve();
				}
			};

			let listeners = this.syncListeners.get(normPath);
			if (!listeners) {
				listeners = new Set();
				this.syncListeners.set(normPath, listeners);
			}
			listeners.add(listener);
		});
	}

	isDocSynced(filePath: string): boolean {
		return this.synced.get(normalizePath(filePath)) ?? false;
	}

	getAwareness(filePath: string): awarenessProtocol.Awareness | null {
		return this.awarenessMap.get(normalizePath(filePath)) ?? null;
	}

	// ------------------------------------------------------------------
	// WebSocket
	// ------------------------------------------------------------------

	private openWebSocket(): void {
		if (this.reconnectTimer !== null) return;
		const { serverUrl, roomId, serverPassword } = this.settings();
		if (!serverUrl || !roomId) return;

		const baseWs = toWsUrl(serverUrl);
		const separator = baseWs.endsWith('/') ? '' : '/';
		const passParam = serverPassword ? `&password=${encodeURIComponent(serverPassword)}` : '';
		const url = `${baseWs}${separator}ws/${encodeURIComponent(roomId)}?display_name=${encodeURIComponent(this.displayName)}${passParam}`;
		const gen = ++this.generation;

		let ws: WebSocket;
		try {
			ws = new WebSocket(url);
		} catch (err) {
			console.error('[Synqra] failed to create WebSocket:', err);
			this.scheduleReconnectTimer();
			return;
		}
		ws.binaryType = 'arraybuffer';
		this.ws = ws;
		this.onStatus('connecting');

		ws.onopen = () => {
			if (gen !== this.generation) return;
			this.isConnected = true;
			this.reconnectAttempts = 0;
			this.onStatus('connected');
			this.startKeepalive();
			for (const filePath of this.docs.keys()) {
				this.synced.set(filePath, false);
				this.sendSubscribe(filePath);
			}
		};

		ws.onmessage = (event) => {
			if (gen !== this.generation) return;
			const data = new Uint8Array(event.data as ArrayBuffer);
			this.handleMessage(data);
		};

		ws.onclose = async () => {
			if (gen !== this.generation) return;
			const wasConnected = this.isConnected;
			this.stopKeepalive();
			this.ws = null;
			this.isConnected = false;
			this.onStatus('disconnected');
			for (const filePath of this.docs.keys()) {
				this.setSynced(filePath, false);
			}

			if (!wasConnected && this.shouldConnect) {
				// Check why handshake failed (e.g. bad password or room does not exist)
				try {
					const httpBase = toHttpUrl(serverUrl);
					const sep = httpBase.endsWith('/') ? '' : '/';
					const probeUrl = `${httpBase}${sep}file/${encodeURIComponent(roomId)}/__probe__${passParam ? '?' + passParam.slice(1) : ''}`;
					const res = await fetch(probeUrl);
					if (res.status === 401) {
						new Notice('[Synqra] Authentication error: Invalid server password. Please check your settings.');
						this.shouldConnect = false;
						return;
					} else if (res.status === 404) {
						try {
							const json = await res.json();
							if (json?.error && json.error.includes('Room')) {
								new Notice(`[Synqra] Room '${roomId}' does not exist on the server. Ask an admin to create it.`);
								this.shouldConnect = false;
								return;
							}
						} catch {}
					}
				} catch {}
			}

			if (this.shouldConnect) {
				this.scheduleReconnectTimer();
			}
		};

		ws.onerror = () => {
			// onclose follows
		};
	}

	private scheduleReconnectTimer(): void {
		if (this.reconnectTimer !== null) return;
		if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
			this.shouldConnect = false;
			return;
		}
		const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
		this.reconnectAttempts++;
		this.reconnectTimer = window.setTimeout(() => {
			this.reconnectTimer = null;
			if (this.shouldConnect) this.openWebSocket();
		}, delay);
	}

	private startKeepalive(): void {
		this.stopKeepalive();
		this.keepaliveTimer = window.setInterval(() => {
			if (this.ws?.readyState === WebSocket.OPEN) {
				// Refresh local awareness to prove liveness / keep NAT open.
				for (const awareness of this.awarenessMap.values()) {
					if (awareness.getLocalState() !== null) {
						awareness.setLocalStateField('__ts', Date.now());
					}
				}
			}
		}, KEEPALIVE_MS);
	}

	private stopKeepalive(): void {
		if (this.keepaliveTimer !== null) {
			window.clearInterval(this.keepaliveTimer);
			this.keepaliveTimer = null;
		}
	}

	// ------------------------------------------------------------------
	// Protocol handling
	// ------------------------------------------------------------------

	private handleMessage(data: Uint8Array): void {
		const { docId, msgType, payload } = decodeMuxMessage(data);
		switch (msgType) {
			case MUX_SUBSCRIBED:
				this.handleSubscribed(docId, payload);
				break;
			case MUX_SYNC:
				this.handleSync(docId, payload);
				break;
			case MUX_SYNC_REQUEST:
				this.handleSyncRequest(docId);
				break;
			case MUX_AWARENESS:
				this.handleAwareness(docId, payload);
				break;
		}
	}

	private handleSubscribed(docId: string, payload: Uint8Array): void {
		const doc = this.docs.get(docId);
		if (!doc) return;

		const syncEncoder = encoding.createEncoder();
		syncProtocol.writeSyncStep1(syncEncoder, doc);
		this.sendMux(docId, MUX_SYNC, encoding.toUint8Array(syncEncoder));
	}

	private handleSyncRequest(docId: string): void {
		const doc = this.docs.get(docId);
		if (!doc) return;
		const syncEncoder = encoding.createEncoder();
		syncProtocol.writeSyncStep1(syncEncoder, doc);
		this.sendMux(docId, MUX_SYNC, encoding.toUint8Array(syncEncoder));
	}

	private handleSync(docId: string, payload: Uint8Array): void {
		const doc = this.docs.get(docId);
		if (!doc) return;

		const decoder = decoding.createDecoder(payload);
		const syncEncoder = encoding.createEncoder();
		const msgType = decoding.peekVarUint(decoder);

		syncProtocol.readSyncMessage(decoder, syncEncoder, doc, this);

		if (encoding.length(syncEncoder) > 0) {
			this.sendMux(docId, MUX_SYNC, encoding.toUint8Array(syncEncoder));
		}

		if (msgType === SYNC_STEP2) {
			this.setSynced(docId, true);
		}
	}

	private handleAwareness(docId: string, payload: Uint8Array): void {
		const awareness = this.awarenessMap.get(docId);
		if (!awareness) return;
		awarenessProtocol.applyAwarenessUpdate(awareness, payload, 'remote');
	}

	private setSynced(docId: string, value: boolean): void {
		const prev = this.synced.get(docId);
		this.synced.set(docId, value);
		if (value && !prev) {
			const listeners = this.syncListeners.get(docId);
			if (listeners) {
				for (const listener of listeners) listener(true);
			}
		}
	}

	private sendMux(docId: string, msgType: number, payload?: Uint8Array): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			const frame = encodeMuxMessage(docId, msgType, payload);
			this.ws.send(frame);
		}
	}

	private sendSubscribe(filePath: string): void {
		const doc = this.docs.get(filePath);
		if (doc) {
			const encoder = encoding.createEncoder();
			encoding.writeVarUint(encoder, doc.clientID);
			this.sendMux(filePath, MUX_SUBSCRIBE, encoding.toUint8Array(encoder));

			// Broadcast our local awareness state so peers know we are here
			const awareness = this.awarenessMap.get(filePath);
			if (awareness && awareness.getLocalState() !== null) {
				const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID]);
				this.sendMux(filePath, MUX_AWARENESS, awarenessUpdate);
			}
		} else {
			this.sendMux(filePath, MUX_SUBSCRIBE);
		}
	}
}