import type { ControlMessage, CollabSettings } from '../types';
import { toWsUrl } from '../utils';

export class ControlChannel {
	private ws: WebSocket | null = null;
	private handlers: ((msg: ControlMessage) => void)[] = [];
	private pingTimer: number | null = null;
	private reconnectTimer: number | null = null;
	private shouldConnect = false;
	private reconnectAttempts = 0;
	private isDestroyed = false;

	onStatusChange: (status: 'connected' | 'connecting' | 'disconnected') => void = () => {};

	constructor(private readonly getSettings: () => CollabSettings) {}

	connect(): void {
		this.shouldConnect = true;
		this.reconnectAttempts = 0;
		this.openWebSocket();
	}

	disconnect(): void {
		this.shouldConnect = false;
		this.stopPing();
		if (this.reconnectTimer !== null) {
			window.clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.ws) {
			const socket = this.ws;
			this.ws = null;
			try {
				socket.close();
			} catch {
				// Ignore close error
			}
		}
		this.onStatusChange('disconnected');
	}

	destroy(): void {
		this.isDestroyed = true;
		this.disconnect();
	}

	send(msg: ControlMessage): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			try {
				this.ws.send(JSON.stringify(msg));
			} catch (err) {
				console.error('[Synqra] failed to send control msg:', err);
			}
		}
	}

	onMessage(handler: (msg: ControlMessage) => void): void {
		this.handlers.push(handler);
	}

	private openWebSocket(): void {
		if (this.isDestroyed || !this.shouldConnect) return;
		const settings = this.getSettings();
		if (!settings.serverUrl || !settings.roomId) return;

		const baseWs = toWsUrl(settings.serverUrl);
		const separator = baseWs.endsWith('/') ? '' : '/';
		const passParam = settings.serverPassword ? `&password=${encodeURIComponent(settings.serverPassword)}` : '';
		const url = `${baseWs}${separator}ws-control/${encodeURIComponent(settings.roomId)}?displayName=${encodeURIComponent(settings.displayName)}${passParam}`;

		this.onStatusChange('connecting');

		let ws: WebSocket;
		try {
			ws = new WebSocket(url);
		} catch (err) {
			console.error('[Synqra] failed to connect control ws:', err);
			this.scheduleReconnect();
			return;
		}

		this.ws = ws;

		ws.onopen = () => {
			if (this.ws !== ws) return;
			this.reconnectAttempts = 0;
			this.onStatusChange('connected');
			this.startPing();
		};

		ws.onmessage = (event) => {
			if (this.ws !== ws) return;
			try {
				const data = typeof event.data === 'string' ? JSON.parse(event.data) : null;
				if (data && typeof data === 'object' && 'type' in data) {
					const msg = data as ControlMessage;
					if (msg.type === 'ping') {
						this.send({ type: 'pong' });
						return;
					}
					for (const handler of this.handlers) {
						handler(msg);
					}
				}
			} catch (err) {
				console.error('[Synqra] failed to parse control msg:', err);
			}
		};

		ws.onclose = () => {
			if (this.ws !== ws) return;
			this.stopPing();
			this.ws = null;
			this.onStatusChange('disconnected');
			if (this.shouldConnect) {
				this.scheduleReconnect();
			}
		};

		ws.onerror = () => {
			// onclose follows
		};
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer !== null || this.isDestroyed) return;
		if (this.reconnectAttempts >= 15) {
			this.shouldConnect = false;
			return;
		}
		const delay = Math.min(100 * 2 ** this.reconnectAttempts, 30_000);
		this.reconnectAttempts++;
		this.reconnectTimer = window.setTimeout(() => {
			this.reconnectTimer = null;
			if (this.shouldConnect) this.openWebSocket();
		}, delay);
	}

	private startPing(): void {
		this.stopPing();
		this.pingTimer = window.setInterval(() => {
			if (this.ws?.readyState === WebSocket.OPEN) {
				this.send({ type: 'ping' });
			}
		}, 20_000);
	}

	private stopPing(): void {
		if (this.pingTimer !== null) {
			window.clearInterval(this.pingTimer);
			this.pingTimer = null;
		}
	}
}
