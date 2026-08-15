export interface ExcalidrawElementStub {
	id: string;
	version: number;
	versionNonce: number;
	isDeleted?: boolean;
	updated?: number;
	[key: string]: unknown;
}

/**
 * Reconcile local and remote Excalidraw elements.
 * Follows the standard Excalidraw collaborative conflict resolution algorithm:
 * - Compares element versions (higher version wins).
 * - On identical versions with different nonces, uses deterministic tie-breaking.
 * - Protects actively drawn/dragged local strokes while immediately merging remote strokes.
 * - Preserves element ordering and handles deletions gracefully.
 */
export function reconcileExcalidrawElements<T extends ExcalidrawElementStub>(
	localElements: readonly T[],
	remoteElements: readonly T[],
	activeLocalElementId?: string,
): T[] {
	const localMap = new Map<string, { element: T; index: number }>();
	localElements.forEach((el, index) => {
		localMap.set(el.id, { element: el, index });
	});

	const remoteMap = new Map<string, T>();
	remoteElements.forEach((el) => {
		remoteMap.set(el.id, el);
	});

	const reconciled: T[] = [];
	const visitedIds = new Set<string>();

	// Process local elements in their original order
	for (const local of localElements) {
		visitedIds.add(local.id);
		const remote = remoteMap.get(local.id);

		if (!remote) {
			reconciled.push(local);
			continue;
		}

		// If local user is actively drawing/dragging this element, protect local state
		if (activeLocalElementId && local.id === activeLocalElementId) {
			reconciled.push(local);
			continue;
		}

		if (remote.version > local.version) {
			reconciled.push(remote);
		} else if (local.version > remote.version) {
			reconciled.push(local);
		} else if (remote.versionNonce !== local.versionNonce) {
			// Deterministic tie-breaker for identical versions
			if (remote.versionNonce > local.versionNonce) {
				reconciled.push(remote);
			} else {
				reconciled.push(local);
			}
		} else {
			// For identical version & nonce (e.g. live freedraw points), accept remote
			reconciled.push(remote);
		}
	}

	// Append any new elements introduced by remote
	for (const remote of remoteElements) {
		if (!visitedIds.has(remote.id)) {
			reconciled.push(remote);
		}
	}

	return reconciled;
}
