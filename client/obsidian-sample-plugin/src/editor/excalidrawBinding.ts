import { App, Notice, TFile, WorkspaceLeaf } from 'obsidian';
import * as Y from 'yjs';
import type * as awarenessProtocol from 'y-protocols/awareness';
import type { SyncManager } from '../syncManager';
import type { CursorUser } from '../types';
import { reconcileExcalidrawElements, type ExcalidrawElementStub } from './excalidrawReconcile';

export interface ExcalidrawCollaborator {
	pointer?: { x: number; y: number };
	button?: 'down' | 'up';
	username?: string;
	color?: {
		background?: string;
		stroke?: string;
	};
	selectedElementIds?: Record<string, boolean>;
}

function getElementFingerprint(el: any): string {
	const pointsLen = el.points ? el.points.length : 0;
	return `${el.id}_${el.version}_${el.versionNonce}_${el.x}_${el.y}_${el.width}_${el.height}_${pointsLen}_${el.isDeleted ? 1 : 0}_${el.text || ''}`;
}

export class ExcalidrawBinding {
	private currentPath: string | null = null;
	private currentView: unknown = null;
	private currentAwareness: awarenessProtocol.Awareness | null = null;
	private currentCursorUser: CursorUser | undefined = undefined;
	private activationGen = 0;
	private yElementsObserver: ((event: Y.YMapEvent<string>, transaction: Y.Transaction) => void) | null = null;
	private awarenessObserver: (() => void) | null = null;
	private unsubscribePointer: (() => void) | null = null;
	private domCleanup: (() => void) | null = null;
	private syncIntervalTimer: number | null = null;
	private isApplyingRemote = false;
	private lastBroadcastFingerprints = new Map<string, string>();

	constructor(
		private readonly app: App,
		private readonly sync: SyncManager,
		private readonly hasFile: (path: string) => boolean,
	) {}

	async activateForFile(
		file: TFile | null,
		cursorUser?: CursorUser,
	): Promise<boolean> {
		const gen = ++this.activationGen;

		if (cursorUser) {
			this.currentCursorUser = cursorUser;
		}

		let leaf: WorkspaceLeaf | null = null;
		let excalidrawView: unknown = null;
		let excalidrawAPI: any = null;

		for (let attempt = 0; attempt < 8; attempt++) {
			leaf = this.app.workspace.activeLeaf ?? null;
			if (leaf) {
				const view = leaf.view as any;
				if (view && (view.getViewType?.() === 'excalidraw' || view.excalidrawAPI)) {
					excalidrawView = view;
					excalidrawAPI = view.excalidrawAPI;
					if (excalidrawAPI) break;
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
			if (this.activationGen !== gen) return false;
		}

		if (!excalidrawAPI) {
			this.unbind();
			return false;
		}

		const filePath = file?.path ?? null;
		if (filePath !== this.currentPath || excalidrawView !== this.currentView) {
			this.unbind();
		}

		this.currentPath = filePath;
		this.currentView = excalidrawView;

		if (!filePath || !this.hasFile(filePath)) {
			this.unbind();
			return false;
		}

		const docHandle = this.sync.getDoc(filePath);
		if (!docHandle) {
			this.unbind();
			return false;
		}

		try {
			await this.sync.waitForSync(filePath);
		} catch {
			if (this.activationGen !== gen) return false;
			new Notice('[Synqra] Excalidraw sync timed out');
			this.unbind();
			return false;
		}

		if (this.activationGen !== gen) return false;

		const yElements = docHandle.doc.getMap<string>('excalidraw_elements');
		this.currentAwareness = docHandle.awareness;

		// Set local user awareness
		const userToUse = this.currentCursorUser;
		if (userToUse) {
			const existing = docHandle.awareness.getLocalState() || {};
			docHandle.awareness.setLocalState({
				...existing,
				user: {
					name: userToUse.name,
					color: userToUse.color,
					colorLight: userToUse.color + '33',
				},
			});
		}

		// Initial sync between Yjs elements map and local Excalidraw scene (including deleted elements)
		const initialSceneElements = (excalidrawAPI.getSceneElementsIncludingDeleted?.() ||
			excalidrawAPI.getSceneElements?.() ||
			[]) as ExcalidrawElementStub[];
		if (yElements.size === 0 && initialSceneElements.length > 0) {
			// Brand new Yjs doc: populate Yjs map from initial local scene
			docHandle.doc.transact(() => {
				for (const el of initialSceneElements) {
					yElements.set(el.id, JSON.stringify(el));
					if (!el.isDeleted) {
						this.lastBroadcastFingerprints.set(el.id, getElementFingerprint(el));
					}
				}
			}, 'local');
		} else if (yElements.size > 0) {
			// Existing Yjs doc: populate local scene from Yjs map
			const remoteElements: ExcalidrawElementStub[] = [];
			for (const raw of yElements.values()) {
				try {
					remoteElements.push(JSON.parse(raw));
				} catch {}
			}
			const merged = reconcileExcalidrawElements(initialSceneElements, remoteElements);
			this.isApplyingRemote = true;
			try {
				excalidrawAPI.updateScene({ elements: merged, commitToHistory: false });
				for (const el of merged) {
					if (el.isDeleted) {
						this.lastBroadcastFingerprints.delete(el.id);
					} else {
						this.lastBroadcastFingerprints.set(el.id, getElementFingerprint(el));
					}
				}
			} finally {
				this.isApplyingRemote = false;
			}
		}

		// Observe remote element updates (CRITICAL: ignore local transactions to prevent self-interruption)
		this.yElementsObserver = (_event: Y.YMapEvent<string>, transaction: Y.Transaction) => {
			if (transaction.local || this.isApplyingRemote) return;

			const appState = excalidrawAPI.getAppState?.() || {};
			const activeId =
				appState.editingElement?.id ||
				appState.draggingElement?.id ||
				appState.resizingElement?.id;

			const currentLocal = (excalidrawAPI.getSceneElementsIncludingDeleted?.() ||
				excalidrawAPI.getSceneElements?.() ||
				[]) as ExcalidrawElementStub[];
			const currentRemote: ExcalidrawElementStub[] = [];
			for (const raw of yElements.values()) {
				try {
					currentRemote.push(JSON.parse(raw));
				} catch {}
			}

			const reconciled = reconcileExcalidrawElements(currentLocal, currentRemote, activeId);
			this.isApplyingRemote = true;
			try {
				excalidrawAPI.updateScene({ elements: reconciled, commitToHistory: false });
				for (const el of reconciled) {
					if (el.id !== activeId) {
						if (el.isDeleted) {
							this.lastBroadcastFingerprints.delete(el.id);
						} else {
							this.lastBroadcastFingerprints.set(el.id, getElementFingerprint(el));
						}
					}
				}
			} finally {
				this.isApplyingRemote = false;
			}
		};
		yElements.observe(this.yElementsObserver);

		// Observe local pointer updates to broadcast live cursor
		if (typeof excalidrawAPI.onPointerUpdate === 'function') {
			this.unsubscribePointer = excalidrawAPI.onPointerUpdate((payload: {
				pointer: { x: number; y: number };
				button: 'down' | 'up';
				pointersMap?: Map<number, unknown>;
			}) => {
				if (!this.currentAwareness) return;
				const selectedElementIds = excalidrawAPI.getAppState?.()?.selectedElementIds || {};
				this.currentAwareness.setLocalStateField('pointer', payload.pointer);
				this.currentAwareness.setLocalStateField('button', payload.button);
				this.currentAwareness.setLocalStateField('selectedElementIds', selectedElementIds);

				if (payload.button === 'up') {
					// Finalize shape/stroke/erase on pointer release
					setTimeout(() => {
						this.syncLocalChanges(excalidrawAPI, yElements, docHandle.doc);
					}, 10);
				}
			});
		}

		// DOM pointer & touch listeners on container for cross-platform / mobile responsiveness
		const viewDom = (excalidrawView as any)?.contentEl as HTMLElement | undefined;
		if (viewDom) {
			const onPointerMove = (e: PointerEvent | TouchEvent) => {
				if ('clientX' in e && this.currentAwareness) {
					const rect = viewDom.getBoundingClientRect();
					const appState = excalidrawAPI.getAppState?.() || {};
					const zoom = appState.zoom?.value || 1;
					const scrollX = appState.scrollX || 0;
					const scrollY = appState.scrollY || 0;
					const canvasX = (e.clientX - rect.left - scrollX) / zoom;
					const canvasY = (e.clientY - rect.top - scrollY) / zoom;
					this.currentAwareness.setLocalStateField('pointer', { x: canvasX, y: canvasY });
				}
			};

			const onPointerUp = () => {
				setTimeout(() => {
					this.syncLocalChanges(excalidrawAPI, yElements, docHandle.doc);
				}, 10);
			};

			viewDom.addEventListener('pointermove', onPointerMove as EventListener, { passive: true });
			viewDom.addEventListener('pointerup', onPointerUp as EventListener, { passive: true });
			viewDom.addEventListener('touchmove', onPointerMove as EventListener, { passive: true });
			viewDom.addEventListener('touchend', onPointerUp as EventListener, { passive: true });

			this.domCleanup = () => {
				viewDom.removeEventListener('pointermove', onPointerMove as EventListener);
				viewDom.removeEventListener('pointerup', onPointerUp as EventListener);
				viewDom.removeEventListener('touchmove', onPointerMove as EventListener);
				viewDom.removeEventListener('touchend', onPointerUp as EventListener);
			};
		}

		// Observe remote awareness to render collaborators on canvas in real-time
		this.awarenessObserver = () => {
			if (!this.currentAwareness || !excalidrawAPI) return;
			const collaborators = new Map<string, ExcalidrawCollaborator>();
			const localClientId = docHandle.awareness.doc.clientID;

			docHandle.awareness.getStates().forEach((state: any, clientId: number) => {
				if (clientId === localClientId) return;
				if (!state || !state.pointer) return;

				const { color = '#30bced', name = 'Anonymous' } = state.user || {};
				collaborators.set(clientId.toString(), {
					pointer: state.pointer,
					button: state.button || 'up',
					username: name,
					color: {
						background: color,
						stroke: color,
					},
					selectedElementIds: state.selectedElementIds || {},
				});
			});

			try {
				excalidrawAPI.updateScene({ collaborators });
			} catch {}
		};
		docHandle.awareness.on('change', this.awarenessObserver);

		// High-frequency sync loop (every 40ms) to detect and broadcast strokes & erasures in real time
		this.syncIntervalTimer = window.setInterval(() => {
			this.syncLocalChanges(excalidrawAPI, yElements, docHandle.doc);
		}, 40);

		return true;
	}

	private syncLocalChanges(
		excalidrawAPI: any,
		yElements: Y.Map<string>,
		ydoc: Y.Doc,
	): void {
		if (this.isApplyingRemote || !excalidrawAPI) return;
		const elements = (excalidrawAPI.getSceneElementsIncludingDeleted?.() ||
			excalidrawAPI.getSceneElements?.() ||
			[]) as ExcalidrawElementStub[];
		if (elements.length === 0 && this.lastBroadcastFingerprints.size === 0) return;

		const currentIds = new Set<string>();
		const changed: ExcalidrawElementStub[] = [];
		const deletedIds: string[] = [];

		for (const el of elements) {
			currentIds.add(el.id);
			if (el.isDeleted) {
				if (this.lastBroadcastFingerprints.has(el.id)) {
					deletedIds.push(el.id);
					this.lastBroadcastFingerprints.delete(el.id);
				}
				continue;
			}
			const fp = getElementFingerprint(el);
			const lastFp = this.lastBroadcastFingerprints.get(el.id);
			if (lastFp !== fp) {
				changed.push(el);
				this.lastBroadcastFingerprints.set(el.id, fp);
			}
		}

		// Also check for elements removed from the scene array entirely
		for (const [id] of this.lastBroadcastFingerprints) {
			if (!currentIds.has(id)) {
				deletedIds.push(id);
			}
		}

		for (const id of deletedIds) {
			this.lastBroadcastFingerprints.delete(id);
		}

		if (changed.length > 0 || deletedIds.length > 0) {
			ydoc.transact(() => {
				for (const el of changed) {
					yElements.set(el.id, JSON.stringify(el));
				}
				for (const id of deletedIds) {
					// Mark as deleted in Yjs map so remote peers erase it cleanly
					yElements.set(
						id,
						JSON.stringify({
							id,
							isDeleted: true,
							version: 999999,
							versionNonce: Math.floor(Math.random() * 1000000),
						}),
					);
				}
			}, 'local');
		}
	}

	unbind(): void {
		if (this.syncIntervalTimer !== null) {
			window.clearInterval(this.syncIntervalTimer);
			this.syncIntervalTimer = null;
		}

		if (this.domCleanup) {
			this.domCleanup();
			this.domCleanup = null;
		}

		if (this.yElementsObserver && this.currentPath) {
			const docHandle = this.sync.getDoc(this.currentPath);
			if (docHandle) {
				const yElements = docHandle.doc.getMap<string>('excalidraw_elements');
				yElements.unobserve(this.yElementsObserver);
			}
			this.yElementsObserver = null;
		}

		if (this.awarenessObserver && this.currentAwareness) {
			this.currentAwareness.off('change', this.awarenessObserver);
			this.currentAwareness.setLocalState(null);
			this.awarenessObserver = null;
		}

		if (this.unsubscribePointer) {
			this.unsubscribePointer();
			this.unsubscribePointer = null;
		}

		this.currentAwareness = null;
		this.currentPath = null;
		this.currentView = null;
		this.lastBroadcastFingerprints.clear();
	}

	destroy(): void {
		this.activationGen++;
		this.unbind();
	}
}
