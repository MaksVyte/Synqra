import { Annotation, EditorSelection, type Extension } from '@codemirror/state';
import { EditorView, layer, type LayerMarker, RectangleMarker, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import * as Y from 'yjs';
import type * as awarenessProtocol from 'y-protocols/awareness';

const remoteCursorsAnnotation = Annotation.define<number[]>();

class RemoteSelectionMarker implements LayerMarker {
	constructor(
		readonly top: number,
		readonly left: number,
		readonly width: number,
		readonly height: number,
		readonly colorLight: string,
		readonly clientId: number,
	) {}

	draw(): HTMLElement {
		const elt = document.createElement('div');
		elt.className = 'cm-remote-selection-box';
		elt.style.position = 'absolute';
		elt.style.top = `${this.top}px`;
		elt.style.left = `${this.left}px`;
		elt.style.width = `${this.width}px`;
		elt.style.height = `${this.height}px`;
		elt.style.backgroundColor = this.colorLight;
		elt.style.pointerEvents = 'none';
		elt.style.userSelect = 'none';
		return elt;
	}

	update(dom: HTMLElement, prev: LayerMarker): boolean {
		if (prev instanceof RemoteSelectionMarker && prev.colorLight === this.colorLight) {
			dom.style.top = `${this.top}px`;
			dom.style.left = `${this.left}px`;
			dom.style.width = `${this.width}px`;
			dom.style.height = `${this.height}px`;
			return true;
		}
		return false;
	}

	eq(other: LayerMarker): boolean {
		return (
			other instanceof RemoteSelectionMarker &&
			other.top === this.top &&
			other.left === this.left &&
			other.width === this.width &&
			other.height === this.height &&
			other.colorLight === this.colorLight &&
			other.clientId === this.clientId
		);
	}
}

class RemoteCursorMarker implements LayerMarker {
	constructor(
		readonly top: number,
		readonly left: number,
		readonly height: number,
		readonly color: string,
		readonly name: string,
		readonly clientId: number,
	) {}

	get width(): number | null {
		return 0;
	}

	draw(): HTMLElement {
		const elt = document.createElement('div');
		elt.className = 'cm-remote-cursor-container';
		elt.style.position = 'absolute';
		elt.style.top = `${this.top}px`;
		elt.style.left = `${this.left - 6}px`;
		elt.style.height = `${this.height}px`;
		elt.style.width = '14px';
		elt.style.pointerEvents = 'auto';
		elt.style.cursor = 'default';
		elt.style.userSelect = 'none';
		elt.style.zIndex = '100';

		const caret = document.createElement('div');
		caret.className = 'cm-remote-cursor-caret';
		caret.style.position = 'absolute';
		caret.style.top = '0';
		caret.style.left = '6px';
		caret.style.width = '2px';
		caret.style.height = '100%';
		caret.style.backgroundColor = this.color;
		caret.style.pointerEvents = 'none';

		const badge = document.createElement('div');
		badge.className = 'cm-remote-cursor-badge';
		badge.textContent = this.name;
		badge.style.position = 'absolute';
		badge.style.bottom = '100%';
		badge.style.left = '6px';
		badge.style.marginBottom = '2px';
		badge.style.backgroundColor = this.color;
		badge.style.color = '#ffffff';
		badge.style.fontSize = '10px';
		badge.style.fontFamily = 'var(--font-text, sans-serif)';
		badge.style.fontWeight = '500';
		badge.style.lineHeight = '1.2';
		badge.style.padding = '1px 5px';
		badge.style.borderRadius = '3px';
		badge.style.whiteSpace = 'nowrap';
		badge.style.pointerEvents = 'none';
		badge.style.userSelect = 'none';
		badge.style.boxShadow = '0 1px 3px rgba(0,0,0,0.25)';

		elt.appendChild(caret);
		elt.appendChild(badge);
		return elt;
	}

	update(dom: HTMLElement, prev: LayerMarker): boolean {
		if (prev instanceof RemoteCursorMarker && prev.color === this.color && prev.name === this.name) {
			dom.style.top = `${this.top}px`;
			dom.style.left = `${this.left - 6}px`;
			dom.style.height = `${this.height}px`;
			return true;
		}
		return false;
	}

	eq(other: LayerMarker): boolean {
		return (
			other instanceof RemoteCursorMarker &&
			other.top === this.top &&
			other.left === this.left &&
			other.height === this.height &&
			other.color === this.color &&
			other.name === this.name &&
			other.clientId === this.clientId
		);
	}
}

export function createRemoteCursorPlugin(
	ytext: Y.Text,
	awareness: awarenessProtocol.Awareness,
): Extension {
	const awarenessTracker = ViewPlugin.fromClass(
		class {
			private readonly listener: (changes: { added: number[]; updated: number[]; removed: number[] }) => void;

			constructor(readonly view: EditorView) {
				this.listener = ({ added, updated, removed }) => {
					const clients = added.concat(updated, removed);
					if (clients.some((id) => id !== awareness.doc.clientID)) {
						view.dispatch({ annotations: [remoteCursorsAnnotation.of(clients)] });
					}
				};
				awareness.on('change', this.listener);
			}

			destroy(): void {
				awareness.off('change', this.listener);
			}

			update(update: ViewUpdate): void {
				const localState = awareness.getLocalState();
				if (localState != null) {
					const hasFocus = update.view.hasFocus;
					const sel = hasFocus ? update.state.selection.main : null;
					const currentAnchor = localState.cursor == null ? null : Y.createRelativePositionFromJSON(localState.cursor.anchor);
					const currentHead = localState.cursor == null ? null : Y.createRelativePositionFromJSON(localState.cursor.head);

					if (sel != null) {
						const anchor = Y.createRelativePositionFromTypeIndex(ytext, sel.anchor);
						const head = Y.createRelativePositionFromTypeIndex(ytext, sel.head);
						if (
							localState.cursor == null ||
							!Y.compareRelativePositions(currentAnchor, anchor) ||
							!Y.compareRelativePositions(currentHead, head)
						) {
							awareness.setLocalStateField('cursor', { anchor, head });
						}
					} else if (localState.cursor != null && !hasFocus) {
						awareness.setLocalStateField('cursor', null);
					}
				}
			}
		},
	);

	const clickHandler = EditorView.domEventHandlers({
		pointerdown(_e, view) {
			setTimeout(() => {
				if (view.dom && view.dom.isConnected && view.hasFocus) {
					const localState = awareness.getLocalState();
					if (localState) {
						const sel = view.state.selection.main;
						const anchor = Y.createRelativePositionFromTypeIndex(ytext, sel.anchor);
						const head = Y.createRelativePositionFromTypeIndex(ytext, sel.head);
						awareness.setLocalStateField('cursor', { anchor, head });
					}
				}
			}, 10);
			return false;
		},
	});

	const selectionLayer = layer({
		above: false, // Render selection highlights behind text in floating overlay
		update(_update: ViewUpdate) {
			return true;
		},
		markers(view: EditorView): readonly LayerMarker[] {
			const ydoc = ytext.doc;
			if (!ydoc) return [];

			const markers: LayerMarker[] = [];
			const docLength = view.state.doc.length;

			awareness.getStates().forEach((state, clientId) => {
				if (clientId === awareness.doc.clientID) return;
				const cursor = state.cursor;
				if (!cursor || !cursor.anchor || !cursor.head) return;

				const anchorPos = Y.createAbsolutePositionFromRelativePosition(cursor.anchor, ydoc);
				const headPos = Y.createAbsolutePositionFromRelativePosition(cursor.head, ydoc);
				if (!anchorPos || !headPos || anchorPos.type !== ytext || headPos.type !== ytext) return;

				const from = Math.max(0, Math.min(anchorPos.index, docLength));
				const to = Math.max(0, Math.min(headPos.index, docLength));
				if (from === to) return;

				const start = Math.min(from, to);
				const end = Math.max(from, to);
				const range = EditorSelection.range(start, end);

				const { color = '#30bced' } = state.user || {};
				const colorLight = (state.user && state.user.colorLight) || color + '33';

				const rectMarkers = RectangleMarker.forRange(view, 'cm-remote-selection-box', range);
				for (const rm of rectMarkers) {
					markers.push(
						new RemoteSelectionMarker(
							rm.top,
							rm.left,
							rm.width ?? 0,
							rm.height,
							colorLight,
							clientId,
						),
					);
				}
			});

			return markers;
		},
	});

	const cursorLayer = layer({
		above: true, // Render cursor carets and name tags above text in floating overlay
		update(_update: ViewUpdate) {
			return true;
		},
		markers(view: EditorView): readonly LayerMarker[] {
			const ydoc = ytext.doc;
			if (!ydoc) return [];

			const markers: LayerMarker[] = [];
			const docLength = view.state.doc.length;

			awareness.getStates().forEach((state, clientId) => {
				if (clientId === awareness.doc.clientID) return;
				const cursor = state.cursor;
				if (!cursor || !cursor.head) return;

				const headPos = Y.createAbsolutePositionFromRelativePosition(cursor.head, ydoc);
				if (!headPos || headPos.type !== ytext) return;

				const pos = Math.max(0, Math.min(headPos.index, docLength));
				const coords = view.coordsAtPos(pos);
				if (!coords) return;

				// Convert viewport coordinates to document-relative layer coordinates
				const docRect = view.scrollDOM.getBoundingClientRect();
				const left = coords.left - docRect.left + view.scrollDOM.scrollLeft;
				const top = coords.top - docRect.top + view.scrollDOM.scrollTop;
				const height = coords.bottom - coords.top || 18;

				const { color = '#30bced', name = 'Anonymous' } = state.user || {};

				markers.push(new RemoteCursorMarker(top, left, height, color, name, clientId));
			});

			return markers;
		},
	});

	return [awarenessTracker, clickHandler, selectionLayer, cursorLayer];
}
