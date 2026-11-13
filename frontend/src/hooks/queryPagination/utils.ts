import { DEFAULT_PER_PAGE_OPTIONS } from './config';
import { Pagination } from './types';

export const checkIsValidPaginationData = (
	{ limit, offset }: Pagination,
	perPageOptions: number[],
): boolean =>
	Boolean(
		Number.isInteger(limit) &&
		limit > 0 &&
		offset >= 0 &&
		perPageOptions.find((option) => option === limit),
	);

// Fork: open lists with 200 rows (or the largest option) instead of the smallest.
export const PREFERRED_PER_PAGE = 200;

export const getDefaultPaginationConfig = (
	perPageOptions = DEFAULT_PER_PAGE_OPTIONS,
): Pagination => ({
	offset: 0,
	limit: perPageOptions.includes(PREFERRED_PER_PAGE)
		? PREFERRED_PER_PAGE
		: Math.max(...perPageOptions),
});
