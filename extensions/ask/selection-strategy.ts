export interface SelectionStrategy {
	toggle(current: Set<string>, value: string): Set<string>;
	isMulti(): boolean;
}

export class MultiSelectStrategy implements SelectionStrategy {
	toggle(current: Set<string>, value: string): Set<string> {
		const next = new Set(current);
		if (next.has(value)) {
			next.delete(value);
		} else {
			next.add(value);
		}
		return next;
	}

	isMulti(): boolean {
		return true;
	}
}

export class SingleSelectStrategy implements SelectionStrategy {
	toggle(current: Set<string>, value: string): Set<string> {
		if (current.has(value)) return new Set();
		return new Set([value]);
	}

	isMulti(): boolean {
		return false;
	}
}
