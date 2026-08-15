import { normalizePath } from '../utils';

export class ExclusionManager {
	isExcluded(rawPath: string): boolean {
		const path = normalizePath(rawPath);
		if (!path) return true;
		if (path.startsWith('.obsidian') || path.startsWith('.git') || path.startsWith('.trash')) {
			return true;
		}
		return false;
	}
}
