import { CSSProperties } from 'react';

export const ITEMS_PER_PAGE_OPTIONS = [25, 50, 100, 200];

// Fork: 200 rows per page by default (upstream: 100).
export const DEFAULT_PER_PAGE_VALUE = 200;

export const defaultSelectStyle: CSSProperties = {
	minWidth: '6rem',
};
