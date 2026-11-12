/**
 * Global namespace scope (fork addition).
 *
 * When a namespace is picked in the side nav, the whole UI is narrowed to it:
 *
 *  - telemetry: every data request gets `service.namespace = '<ns>'`
 *    (query_range v3/v4/v5, exports, services/errors, infra monitoring,
 *    metrics explorer, messaging queues, autocomplete values);
 *  - single traces: opening a trace by id is refused unless at least one of
 *    its spans belongs to the namespace;
 *  - saved objects: dashboards (tag `namespace:<ns>`), alert rules and firing
 *    alerts (label `namespace=<ns>`) and saved views (their own query filters
 *    on service.namespace) are listed only when they belong to the namespace
 *    or are shared (carry no namespace at all);
 *  - new objects created while scoped are stamped with the namespace (and a
 *    new alert's queries are filtered to it, so it only fires on its data).
 *
 * Nothing selected = no change, the UI behaves exactly like upstream SigNoz.
 * Telemetry filters are applied to a deep copy of the request body, so
 * objects being *read* for display are never modified.
 */
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { getBasePath } from 'utils/basePath';

export const NAMESPACE_ATTRIBUTE = 'service.namespace';
/** Tag key on dashboards / label key on alert rules. */
export const NAMESPACE_TAG = 'namespace';
const STORAGE_KEY = 'SIGNOZ_GLOBAL_NAMESPACE';

export function getSelectedNamespace(): string | null {
	try {
		const value = window.localStorage.getItem(STORAGE_KEY);
		return value && value.trim() ? value : null;
	} catch {
		return null;
	}
}

export function setSelectedNamespace(namespace: string | null): void {
	try {
		if (namespace) {
			window.localStorage.setItem(STORAGE_KEY, namespace);
		} else {
			window.localStorage.removeItem(STORAGE_KEY);
		}
	} catch {
		// storage unavailable - selection just won't persist
	}
}

const quote = (value: string): string =>
	`'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export const namespaceExpression = (namespace: string): string =>
	`${NAMESPACE_ATTRIBUTE} = ${quote(namespace)}`;

const andExpression = (existing: unknown, condition: string): string =>
	typeof existing === 'string' && existing.trim()
		? `(${existing}) AND ${condition}`
		: condition;

/** DSL for object lists: belongs to the namespace, or is shared (no namespace). */
const objectListExpression = (namespace: string): string =>
	`(${NAMESPACE_TAG} = ${quote(namespace)} OR ${NAMESPACE_TAG} NOT EXISTS)`;

const deepCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/* ------------------------------------------------------------------ */
/* request bodies                                                      */
/* ------------------------------------------------------------------ */

/** v5 envelopes: [{ type: 'builder_query', spec: { filter: { expression } } }] */
function scopeV5Queries(queries: unknown, namespace: string): void {
	if (!Array.isArray(queries)) {
		return;
	}
	queries.forEach((query: any) => {
		if (!query || query.type !== 'builder_query' || !query.spec) {
			return;
		}
		query.spec.filter = {
			...(query.spec.filter || {}),
			expression: andExpression(
				query.spec.filter?.expression,
				namespaceExpression(namespace),
			),
		};
	});
}

/**
 * v3/v4: { builderQueries: { A: { dataSource, filters: { items } } } }
 * The v3/v4 backend model (pkg/query-service/model/v3 BuilderQuery) only reads
 * `filters.items`; a `filter.expression` the UI may also send is ignored there.
 */
function scopeV3V4Queries(builderQueries: unknown, namespace: string): void {
	if (!builderQueries || typeof builderQueries !== 'object') {
		return;
	}
	Object.values(builderQueries as Record<string, any>).forEach((query) => {
		// formulas live in builderQueries too, but have no data source to filter
		if (!query || !query.dataSource) {
			return;
		}
		const filters = query.filters || { items: [], op: 'AND' };
		query.filters = {
			...filters,
			op: filters.op || 'AND',
			items: [...(filters.items || []), namespaceFilterItem(namespace)],
		};
	});
}

const namespaceFilterItem = (namespace: string): Record<string, unknown> => ({
	key: {
		key: NAMESPACE_ATTRIBUTE,
		dataType: 'string',
		type: 'resource',
		isColumn: false,
		isJSON: false,
	},
	op: '=',
	value: namespace,
});

function scopeCompositeQuery(composite: any, namespace: string): void {
	if (!composite) {
		return;
	}
	scopeV5Queries(composite.queries, namespace);
	scopeV3V4Queries(composite.builderQueries, namespace);
}

/** v2 services / errors: { tags: [{ Key, Operator, StringValues }] } */
function scopeServiceTags(body: any, namespace: string): void {
	const tags = Array.isArray(body.tags) ? body.tags : [];
	body.tags = [
		...tags.filter((tag: any) => tag?.Key !== NAMESPACE_ATTRIBUTE),
		{
			Key: NAMESPACE_ATTRIBUTE,
			Operator: 'In',
			StringValues: [namespace],
			NumberValues: [],
			BoolValues: [],
			// listErrors/countErrors pick the ClickHouse map column from this;
			// without it they build invalid SQL (same value the UI's own
			// resource-attribute filters send)
			TagType: 'ResourceAttribute',
		},
	];
}

/** infra monitoring, metrics explorer: { filter: { expression } } */
function scopeTopLevelFilter(body: any, namespace: string): void {
	body.filter = {
		...(body.filter || {}),
		expression: andExpression(
			body.filter?.expression,
			namespaceExpression(namespace),
		),
	};
}

/** celery queue overview: { filters: { items } } */
function scopeTopLevelFilterItems(body: any, namespace: string): void {
	const filters = body.filters || { items: [], op: 'AND' };
	body.filters = {
		...filters,
		op: filters.op || 'AND',
		items: [...(filters.items || []), namespaceFilterItem(namespace)],
	};
}

const mentionsNamespace = (value: unknown): boolean =>
	JSON.stringify(value ?? '').includes(NAMESPACE_ATTRIBUTE);

/** New alert rule: label it and filter its queries to the namespace. */
function stampRule(body: any, namespace: string): void {
	body.labels = { ...(body.labels || {}) };
	if (!body.labels[NAMESPACE_TAG]) {
		body.labels[NAMESPACE_TAG] = namespace;
	}
	if (body.labels[NAMESPACE_TAG] === namespace) {
		const composite = body.condition?.compositeQuery;
		if (composite && !mentionsNamespace(composite)) {
			scopeCompositeQuery(composite, namespace);
		}
	}
}

/** New dashboard: tag it (v2 tags are { key, value } pairs). */
function stampDashboard(body: any, namespace: string): void {
	const tags = Array.isArray(body.tags) ? body.tags : [];
	if (!tags.some((tag: any) => tag?.key === NAMESPACE_TAG)) {
		body.tags = [...tags, { key: NAMESPACE_TAG, value: namespace }];
	}
}

/** New saved view: a view belongs to a namespace through its own query. */
function stampSavedView(body: any, namespace: string): void {
	const queries = body.spec?.queries;
	if (queries && !mentionsNamespace(queries)) {
		scopeV5Queries(queries, namespace);
	}
}

type BodyRule = {
	method: 'post' | 'put';
	path: RegExp;
	apply: (body: any, namespace: string) => void;
};

const BODY_RULES: BodyRule[] = [
	// telemetry
	{
		method: 'post',
		// builder query_range v3/v4/v5 (PromQL's /prometheus/... form body is not ours)
		path: /^(?!.*prometheus).*\/query_range(\/preview)?\/?$/,
		apply: (body, ns): void => scopeCompositeQuery(body.compositeQuery, ns),
	},
	{
		method: 'post',
		path: /(^|\/)export_raw_data\/?$/,
		apply: (body, ns): void => scopeCompositeQuery(body.compositeQuery, ns),
	},
	{
		method: 'post',
		path:
			/\/(services|service\/(top_operations|entry_point_operations|top_level_operations)|listErrors|countErrors)\/?$/,
		apply: scopeServiceTags,
	},
	{
		method: 'post',
		path: /\/infra_monitoring\/[a-z_]+\/?$/,
		apply: scopeTopLevelFilter,
	},
	{
		method: 'post',
		path: /\/metrics\/(stats|treemap|inspect)\/?$/,
		apply: scopeTopLevelFilter,
	},
	{
		method: 'post',
		path: /\/third-party-apis\/overview\/list\/?$/,
		apply: scopeTopLevelFilter,
	},
	{
		method: 'post',
		path: /messaging-queues\/queue-overview\/?$/,
		apply: scopeTopLevelFilterItems,
	},
	// new objects
	{ method: 'post', path: /\/api\/v[12]\/rules\/?$/, apply: stampRule },
	{ method: 'post', path: /\/api\/v2\/dashboards\/?$/, apply: stampDashboard },
	{ method: 'post', path: /\/api\/v2\/saved_views\/?$/, apply: stampSavedView },
];

const parseBody = (data: unknown): any => {
	if (typeof data === 'string') {
		try {
			return JSON.parse(data);
		} catch {
			return null;
		}
	}
	if (data && typeof data === 'object' && !(data instanceof FormData)) {
		// deep copy: never mutate the caller's object (react-query keys, saved specs)
		return deepCopy(data);
	}
	return null;
};

/** Returns the request body with the namespace applied, or the original data. */
export function scopeRequestBody(
	path: string,
	method: string | undefined,
	data: unknown,
	namespace: string | null,
): unknown {
	if (!namespace) {
		return data;
	}
	const verb = (method || 'get').toLowerCase();
	const rule = BODY_RULES.find((r) => r.method === verb && r.path.test(path));
	if (!rule) {
		return data;
	}
	const body = parseBody(data);
	if (!body) {
		return data;
	}
	rule.apply(body, namespace);
	return typeof data === 'string' ? JSON.stringify(body) : body;
}

/* ------------------------------------------------------------------ */
/* query-string params                                                 */
/* ------------------------------------------------------------------ */

const DSL_LIST_PATHS = [
	/\/api\/v2\/users\/me\/dashboards\/?$/,
	/\/api\/v2\/dashboards\/?$/,
	/\/api\/v3\/rules\/?$/,
];
const FIELD_VALUES_PATH = /\/fields\/values\/?$/;

export function scopeRequestParams(
	path: string,
	method: string | undefined,
	params: unknown,
	namespace: string | null,
): unknown {
	if (!namespace || (method || 'get').toLowerCase() !== 'get') {
		return params;
	}
	const current = (params && typeof params === 'object' ? params : {}) as Record<
		string,
		unknown
	>;

	if (DSL_LIST_PATHS.some((re) => re.test(path))) {
		return {
			...current,
			query: andExpression(current.query, objectListExpression(namespace)),
		};
	}
	// autocomplete: narrow values to the namespace, except for the namespace
	// key itself (the side-nav selector must still list every namespace)
	if (FIELD_VALUES_PATH.test(path) && current.name !== NAMESPACE_ATTRIBUTE) {
		return {
			...current,
			existingQuery: andExpression(
				current.existingQuery,
				namespaceExpression(namespace),
			),
		};
	}
	return params;
}

/* ------------------------------------------------------------------ */
/* single trace by id                                                  */
/* ------------------------------------------------------------------ */

const TRACE_BY_ID = [
	/\/traces\/([0-9a-fA-F]{16,32})\/(waterfall|flamegraph|summary|aggregations|thread)\/?$/,
	/\/traces\/flamegraph\/([0-9a-fA-F]{16,32})\/?$/,
];
const TRACE_LOOKBACK_MS = 31 * 24 * 60 * 60 * 1000;
const traceChecks = new Map<string, Promise<boolean>>();

export const traceIdFromPath = (path: string): string | null => {
	for (const re of TRACE_BY_ID) {
		const match = path.match(re);
		if (match) {
			return match[1].toLowerCase();
		}
	}
	return null;
};

async function traceInNamespace(
	traceId: string,
	namespace: string,
	authorization: string,
): Promise<boolean> {
	const end = Date.now();
	const response = await fetch(`${getBasePath()}api/v5/query_range`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', Authorization: authorization },
		body: JSON.stringify({
			schemaVersion: 'v1',
			start: end - TRACE_LOOKBACK_MS,
			end,
			requestType: 'raw',
			compositeQuery: {
				queries: [
					{
						type: 'builder_query',
						spec: {
							name: 'A',
							signal: 'traces',
							limit: 1,
							selectFields: [{ name: 'trace_id' }],
							filter: {
								expression: `trace_id = ${quote(traceId)} AND ${namespaceExpression(
									namespace,
								)}`,
							},
						},
					},
				],
			},
		}),
	});
	if (!response.ok) {
		// can't tell - don't hide the trace because the check itself failed
		return true;
	}
	const json = await response.json();
	const results = json?.data?.data?.results || [];
	return results.some((r: any) => Array.isArray(r?.rows) && r.rows.length > 0);
}

export class NamespaceScopeError extends Error {
	constructor(traceId: string, namespace: string) {
		super(`Trace ${traceId} is not part of namespace "${namespace}"`);
		this.name = 'NamespaceScopeError';
	}
}

/* ------------------------------------------------------------------ */
/* list responses filtered client-side (endpoints without a DSL)       */
/* ------------------------------------------------------------------ */

const labelAllowed = (labels: any, namespace: string): boolean => {
	const value = labels?.[NAMESPACE_TAG];
	return !value || value === namespace;
};

const viewAllowed = (view: any, namespace: string): boolean => {
	const text = JSON.stringify(view?.spec?.queries ?? '');
	if (!text.includes(NAMESPACE_ATTRIBUTE)) {
		return true; // shared view
	}
	// views saved while scoped carry exactly this condition (see stampSavedView)
	return text.includes(namespaceExpression(namespace));
};

type ListRule = {
	path: RegExp;
	keep: (item: any, namespace: string) => boolean;
};

const LIST_RULES: ListRule[] = [
	{
		path: /\/api\/v[12]\/rules\/?$/,
		keep: (r, ns): boolean => labelAllowed(r?.labels, ns),
	},
	// hand-written client calls '/alerts' on the /api/v1 instance
	{
		path: /(^|\/api\/v1)\/alerts\/?$/,
		keep: (a, ns): boolean => labelAllowed(a?.labels, ns),
	},
	{ path: /\/api\/v2\/saved_views\/?$/, keep: viewAllowed },
];

export function scopeResponseData(
	path: string,
	method: string | undefined,
	data: any,
	namespace: string | null,
): any {
	if (!namespace || (method || 'get').toLowerCase() !== 'get' || !data) {
		return data;
	}
	const rule = LIST_RULES.find((r) => r.path.test(path));
	if (!rule || !Array.isArray(data.data)) {
		return data;
	}
	return {
		...data,
		data: data.data.filter((item: any) => rule.keep(item, namespace)),
	};
}

/* ------------------------------------------------------------------ */
/* axios glue                                                          */
/* ------------------------------------------------------------------ */

// baseURL '/api/v1/' + url '/alerts' gives '/api/v1//alerts' - collapse it
// (but keep the '//' of an absolute dev URL like http://host)
const fullPath = (config: { baseURL?: string; url?: string }): string =>
	`${config.baseURL || ''}${config.url || ''}`
		.split('?')[0]
		.replace(/([^:])\/{2,}/g, '$1/');

/**
 * How a request to `method path` is scoped, or null when it is not touched.
 * Used by the endpoint coverage test to flag API endpoints added upstream.
 */
export function describeScope(method: string, path: string): string | null {
	const verb = method.toLowerCase();
	const body = BODY_RULES.find((r) => r.method === verb && r.path.test(path));
	if (body) {
		return `body:${body.apply.name || 'rule'}`;
	}
	if (verb === 'get' && DSL_LIST_PATHS.some((re) => re.test(path))) {
		return 'params:object-list-dsl';
	}
	if (verb === 'get' && FIELD_VALUES_PATH.test(path)) {
		return 'params:existing-query';
	}
	if (verb === 'get' && LIST_RULES.some((r) => r.path.test(path))) {
		return 'response:list-filter';
	}
	const tracePath = path.replace(/\{[^}]*\}/g, '0123456789abcdef');
	if (traceIdFromPath(tracePath)) {
		return 'trace-guard';
	}
	return null;
}

export function applyNamespaceScope(
	config: InternalAxiosRequestConfig,
): InternalAxiosRequestConfig | Promise<InternalAxiosRequestConfig> {
	const namespace = getSelectedNamespace();
	if (!namespace) {
		return config;
	}
	const path = fullPath(config);
	config.data = scopeRequestBody(path, config.method, config.data, namespace);
	config.params = scopeRequestParams(
		path,
		config.method,
		config.params,
		namespace,
	);

	const traceId = traceIdFromPath(path);
	if (!traceId) {
		return config;
	}
	const key = `${namespace}:${traceId}`;
	if (!traceChecks.has(key)) {
		const authorization = String(config.headers?.Authorization || '');
		traceChecks.set(
			key,
			traceInNamespace(traceId, namespace, authorization).catch(() => true),
		);
	}
	return (traceChecks.get(key) as Promise<boolean>).then((inScope) => {
		if (!inScope) {
			throw new NamespaceScopeError(traceId, namespace);
		}
		return config;
	});
}

export function applyNamespaceScopeToResponse<T extends AxiosResponse>(
	response: T,
): T {
	const namespace = getSelectedNamespace();
	if (!namespace || !response?.config) {
		return response;
	}
	response.data = scopeResponseData(
		fullPath(response.config),
		response.config.method,
		response.data,
		namespace,
	);
	return response;
}
