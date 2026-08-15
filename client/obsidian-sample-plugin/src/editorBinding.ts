import { App, MarkdownView, Notice, TFile } from 'obsidian';
import { Compartment, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ySync, ySyncFacet, YSyncConfig } from 'y-codemirror.next';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';
import type { SyncManager } from './syncManager';
import type { CursorUser } from './types';
import { applyMinimalYTextUpdate, isExcalidrawFile, normalizeLineEndings } from './utils';
import { createRemoteCursorPlugin } from './editor/remoteCursors';

export class EditorBinding {
	private compartment = new Compartment();
	private currentPath: string | null = null;
	private currentView: EditorView | null = null;
	private currentAwareness: awarenessProtocol.Awareness | null = null;
	private currentCursorUser: CursorUser | undefined = undefined;
	private activationGen = 0;
	private onVisibilityChange: () => void;

	constructor(
		private readonly app: App,
		private readonly sync: SyncManager,
		private readonly hasFile: (path: string) => boolean,
	) {
		this.onVisibilityChange = () => {
			if (document.visibilityState === 'visible' && this.currentAwareness && this.currentPath) {
				const leaf = this.app.workspace.activeLeaf ?? null;
				const view = leaf && leaf.view instanceof MarkdownView
					? (leaf.view as unknown as { editor?: { cm?: EditorView } }).editor?.cm
					: null;
				if (view && !(view as unknown as { destroyed?: boolean }).destroyed) {
					try {
						const selection = view.state.selection.main;
						const docHandle = this.sync.getDoc(this.currentPath);
						if (!docHandle) return;
						const anchor = Y.createRelativePositionFromTypeIndex(docHandle.text, selection.anchor);
						const head = Y.createRelativePositionFromTypeIndex(docHandle.text, selection.head);
						this.currentAwareness.setLocalStateField('cursor', { anchor, head });
					} catch {}
				}
			}
		};
		document.addEventListener('visibilitychange', this.onVisibilityChange);
	}

	getBaseExtension(): Extension {
		return this.compartment.of([]);
	}

	unbind(): void {
		if (this.currentAwareness) {
			this.currentAwareness.setLocalState(null);
			this.currentAwareness = null;
		}
		if (this.currentView) {
			try {
				this.currentView.dispatch({
					effects: this.compartment.reconfigure([]),
				});
			} catch {
				// View already destroyed
			}
			this.currentView = null;
		}
		this.currentPath = null;
	}

	async activateForFile(
		file: TFile | null,
		cursorUser?: CursorUser,
	): Promise<boolean> {
		const gen = ++this.activationGen;
		const filePath = file?.path ?? null;

		// Synchronously unbind any existing file binding immediately
		if (filePath !== this.currentPath) {
			this.unbind();
		}

		if (cursorUser) {
			this.currentCursorUser = cursorUser;
		}

		if (!filePath || !this.hasFile(filePath) || isExcalidrawFile(filePath)) {
			this.unbind();
			return false;
		}

		let leaf: any = null;
		let view: EditorView | null = null;

		for (let attempt = 0; attempt < 5; attempt++) {
			leaf = this.app.workspace.activeLeaf ?? null;
			if (leaf && leaf.view instanceof MarkdownView) {
				const cm = (leaf.view as unknown as { editor?: { cm?: EditorView } }).editor?.cm;
				if (cm && !(cm as unknown as { destroyed?: boolean }).destroyed) {
					view = cm;
					break;
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 40));
			if (this.activationGen !== gen) return false;
		}

		if (!view) {
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
			new Notice('[Synqra] sync timed out');
			this.unbind();
			return false;
		}

		if (this.activationGen !== gen) return false;
		if ((view as unknown as { destroyed?: boolean }).destroyed) {
			this.unbind();
			return false;
		}

		this.currentPath = filePath;
		this.currentView = view;
		this.currentAwareness = docHandle.awareness;

		const userToUse = this.currentCursorUser;
		if (userToUse) {
			const existingState = docHandle.awareness.getLocalState() || {};
			docHandle.awareness.setLocalState({
				...existingState,
				user: {
					name: userToUse.name,
					color: userToUse.color,
					colorLight: userToUse.color + '33',
				},
			});
		}

		const localContent = normalizeLineEndings(view.state.doc.toString());
		const remoteContent = docHandle.text.toString();

		const ySyncConfig = new YSyncConfig(docHandle.text, docHandle.awareness);
		const extensions: Extension[] = [
			ySyncFacet.of(ySyncConfig),
			ySync,
			createRemoteCursorPlugin(docHandle.text, docHandle.awareness),
		];

		if (remoteContent !== localContent) {
			if (remoteContent.length === 0 && localContent.length > 0) {
				applyMinimalYTextUpdate(docHandle.doc, docHandle.text, localContent);
				view.dispatch({
					effects: this.compartment.reconfigure(extensions),
				});
			} else {
				view.dispatch({
					changes: { from: 0, to: view.state.doc.length, insert: remoteContent },
					effects: this.compartment.reconfigure(extensions),
				});
				if (file && this.hasFile(filePath) && this.app.vault.getAbstractFileByPath(file.path)) {
					try {
						await this.app.vault.modify(file, remoteContent);
					} catch {
						// Ignore concurrent write
					}
				}
			}
		} else {
			view.dispatch({
				effects: this.compartment.reconfigure(extensions),
			});
		}

		try {
			const selection = view.state.selection.main;
			const anchor = Y.createRelativePositionFromTypeIndex(docHandle.text, selection.anchor);
			const head = Y.createRelativePositionFromTypeIndex(docHandle.text, selection.head);
			docHandle.awareness.setLocalStateField('cursor', { anchor, head });
		} catch {
			// Selection indexing safety
		}

		return true;
	}

	destroy(): void {
		this.activationGen++;
		document.removeEventListener('visibilitychange', this.onVisibilityChange);
		this.unbind();
	}
}