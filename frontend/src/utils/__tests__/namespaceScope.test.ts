import {
	applyNamespaceScopeToResponse,
	scopeRequestBody,
	scopeRequestParams,
	scopeResponseData,
	setSelectedNamespace,
	traceIdFromPath,
} from 'utils/namespaceScope';

describe('scopeRequestBody', () => {
	const v5Body = (): any => ({
		compositeQuery: {
			queries: [
				{
					type: 'builder_query',
					spec: {
						signal: 'logs',
						filter: { expression: "severity_text = 'ERROR'" },
					},
				},
				{ type: 'builder_query', spec: { signal: 'traces' } },
				{ type: 'builder_formula', spec: { expression: 'A/B' } },
				{ type: 'promql', spec: { query: 'up' } },
			],
		},
	});

	it('leaves requests untouched when no namespace is selected', () => {
		const body = v5Body();
		expect(scopeRequestBody('/api/v5/query_range', 'post', body, null)).toBe(
			body,
		);
	});

	it('ANDs the namespace into v5 builder queries only, without mutating input', () => {
		const body = v5Body();
		const out: any = scopeRequestBody(
			'/api/v5//query_range',
			'post',
			body,
			'shop',
		);
		expect(out.compositeQuery.queries[0].spec.filter.expression).toBe(
			"(severity_text = 'ERROR') AND service.namespace = 'shop'",
		);
		expect(out.compositeQuery.queries[1].spec.filter.expression).toBe(
			"service.namespace = 'shop'",
		);
		expect(out.compositeQuery.queries[2].spec).toEqual({ expression: 'A/B' });
		expect(out.compositeQuery.queries[3].spec).toEqual({ query: 'up' });
		expect(body.compositeQuery.queries[1].spec.filter).toBeUndefined();
	});

	it('escapes quotes in the namespace', () => {
		const out: any = scopeRequestBody(
			'/api/v5/query_range',
			'post',
			v5Body(),
			"o'x",
		);
		expect(out.compositeQuery.queries[1].spec.filter.expression).toBe(
			"service.namespace = 'o\\'x'",
		);
	});

	it('adds a resource filter item to v3/v4 builder queries', () => {
		const out: any = scopeRequestBody(
			'/api/v4/query_range',
			'post',
			{
				compositeQuery: {
					builderQueries: {
						A: {
							dataSource: 'traces',
							filter: { expression: '' },
							filters: {
								items: [{ key: { key: 'serviceName' }, op: '=', value: 'api' }],
								op: 'AND',
							},
						},
						F1: { queryName: 'F1', expression: 'A/2' },
					},
				},
			},
			'shop',
		);
		const { A, F1 } = out.compositeQuery.builderQueries;
		expect(A.filters.items).toHaveLength(2);
		expect(A.filters.items[1]).toMatchObject({
			key: { key: 'service.namespace', type: 'resource' },
			op: '=',
			value: 'shop',
		});
		expect(A.filter).toEqual({ expression: '' });
		expect(F1.filters).toBeUndefined();
	});

	it('adds a namespace tag to the services endpoint', () => {
		const out: any = scopeRequestBody(
			'/api/v2/services',
			'post',
			{ start: '1', end: '2', tags: [] },
			'shop',
		);
		expect(out.tags).toEqual([
			{
				Key: 'service.namespace',
				Operator: 'In',
				StringValues: ['shop'],
				NumberValues: [],
				BoolValues: [],
				TagType: 'ResourceAttribute',
			},
		]);
	});

	it('ignores other endpoints and GETs', () => {
		const body = { title: 'dash' };
		expect(scopeRequestBody('/api/v1/dashboards', 'post', body, 'shop')).toBe(
			body,
		);
		expect(scopeRequestBody('/api/v5/query_range', 'get', body, 'shop')).toBe(
			body,
		);
	});

	it('scopes infra monitoring and metrics explorer filters', () => {
		const out: any = scopeRequestBody(
			'/api/v2/infra_monitoring/hosts',
			'post',
			{
				start: 1,
				end: 2,
				limit: 10,
				filter: { expression: "host.name = 'a'", filterByStatus: 'active' },
			},
			'shop',
		);
		expect(out.filter).toEqual({
			expression: "(host.name = 'a') AND service.namespace = 'shop'",
			filterByStatus: 'active',
		});
		const stats: any = scopeRequestBody(
			'/api/v2/metrics/stats',
			'post',
			{ start: 1, end: 2, limit: 5 },
			'shop',
		);
		expect(stats.filter.expression).toBe("service.namespace = 'shop'");
	});

	it('scopes raw exports like query_range', () => {
		const out: any = scopeRequestBody(
			'/api/v1/export_raw_data',
			'post',
			v5Body(),
			'shop',
		);
		expect(out.compositeQuery.queries[1].spec.filter.expression).toBe(
			"service.namespace = 'shop'",
		);
	});

	it('stamps new dashboards, rules and saved views', () => {
		const dash: any = scopeRequestBody(
			'/api/v2/dashboards',
			'post',
			{ spec: {}, tags: [{ key: 'team', value: 'x' }] },
			'shop',
		);
		expect(dash.tags).toEqual([
			{ key: 'team', value: 'x' },
			{ key: 'namespace', value: 'shop' },
		]);

		const rule: any = scopeRequestBody(
			'/api/v2/rules',
			'post',
			{ alert: 'r', condition: { compositeQuery: v5Body().compositeQuery } },
			'shop',
		);
		expect(rule.labels).toEqual({ namespace: 'shop' });
		expect(rule.condition.compositeQuery.queries[1].spec.filter.expression).toBe(
			"service.namespace = 'shop'",
		);

		const explicit: any = scopeRequestBody(
			'/api/v2/rules',
			'post',
			{
				labels: { namespace: 'other' },
				condition: { compositeQuery: v5Body().compositeQuery },
			},
			'shop',
		);
		expect(explicit.labels.namespace).toBe('other');
		expect(
			explicit.condition.compositeQuery.queries[1].spec.filter,
		).toBeUndefined();

		const view: any = scopeRequestBody(
			'/api/v2/saved_views',
			'post',
			{ name: 'v', spec: { queries: v5Body().compositeQuery.queries } },
			'shop',
		);
		expect(view.spec.queries[1].spec.filter.expression).toBe(
			"service.namespace = 'shop'",
		);
	});

	it('does not touch updates of existing objects', () => {
		const body = { spec: {}, tags: [] };
		expect(scopeRequestBody('/api/v2/dashboards/abc', 'put', body, 'shop')).toBe(
			body,
		);
	});

	it('adds the object-list DSL to dashboard and rule list params', () => {
		expect(
			scopeRequestParams(
				'/api/v2/users/me/dashboards',
				'get',
				{ limit: 20 },
				'shop',
			),
		).toEqual({
			limit: 20,
			query: "(namespace = 'shop' OR namespace NOT EXISTS)",
		});
		expect(
			scopeRequestParams(
				'/api/v3/rules',
				'get',
				{ query: "name CONTAINS 'x'" },
				'shop',
			),
		).toEqual({
			query:
				"(name CONTAINS 'x') AND (namespace = 'shop' OR namespace NOT EXISTS)",
		});
		expect(
			scopeRequestParams('/api/v2/dashboards/abc', 'get', undefined, 'shop'),
		).toBeUndefined();
	});

	it('narrows autocomplete values but not the namespace list itself', () => {
		expect(
			scopeRequestParams(
				'/api/v1/fields/values',
				'get',
				{ name: 'service.name' },
				'shop',
			),
		).toEqual({
			name: 'service.name',
			existingQuery: "service.namespace = 'shop'",
		});
		const own = { name: 'service.namespace' };
		expect(scopeRequestParams('/api/v1/fields/values', 'get', own, 'shop')).toBe(
			own,
		);
	});

	it('filters rule, alert and saved-view lists to own + shared', () => {
		const rules = scopeResponseData(
			'/api/v2/rules',
			'get',
			{
				status: 'success',
				data: [
					{ id: 1, labels: { namespace: 'shop' } },
					{ id: 2, labels: { namespace: 'other' } },
					{ id: 3, labels: {} },
					{ id: 4 },
				],
			},
			'shop',
		);
		expect(rules.data.map((r: any) => r.id)).toEqual([1, 3, 4]);

		const alerts = scopeResponseData(
			'/api/v1/alerts',
			'get',
			{
				data: [
					{ labels: { namespace: 'other' } },
					{ labels: { severity: 'critical' } },
				],
			},
			'shop',
		);
		expect(alerts.data).toHaveLength(1);

		const q = (expr: string): any => ({
			spec: {
				queries: [
					{ type: 'builder_query', spec: { filter: { expression: expr } } },
				],
			},
		});
		const views = scopeResponseData(
			'/api/v2/saved_views',
			'get',
			{
				data: [
					{ id: 'mine', ...q("(x = 1) AND service.namespace = 'shop'") },
					{ id: 'theirs', ...q("service.namespace = 'other'") },
					{ id: 'shared', ...q("severity_text = 'ERROR'") },
				],
			},
			'shop',
		);
		expect(views.data.map((v: any) => v.id)).toEqual(['mine', 'shared']);

		const untouched = { data: [{ labels: { namespace: 'other' } }] };
		expect(scopeResponseData('/api/v2/rules', 'get', untouched, null)).toBe(
			untouched,
		);
	});

	it('recognises trace-by-id endpoints', () => {
		expect(
			traceIdFromPath('/api/v4/traces/94F423245638EBFA9ED92E435CEAC263/waterfall'),
		).toBe('94f423245638ebfa9ed92e435ceac263');
		expect(traceIdFromPath('/api/v1/traces/flamegraph/94f423245638ebfa')).toBe(
			'94f423245638ebfa',
		);
		expect(traceIdFromPath('/api/v5/query_range')).toBeNull();
	});

	it('scopes the external APIs overview and ignores PromQL', () => {
		const out: any = scopeRequestBody(
			'/api/v1/third-party-apis/overview/list',
			'post',
			{ start: 1, end: 2, show_ip: false, filter: { expression: '' } },
			'shop',
		);
		expect(out.filter.expression).toBe("service.namespace = 'shop'");
		const prom = 'query=up&start=1&end=2';
		expect(
			scopeRequestBody('/prometheus/api/v1/query_range', 'post', prom, 'shop'),
		).toBe(prom);
	});

	it('handles the double slash the hand-written alerts client produces', () => {
		setSelectedNamespace('shop');
		try {
			const response: any = applyNamespaceScopeToResponse({
				config: { baseURL: '/api/v1/', url: '/alerts?active=true', method: 'get' },
				data: { data: [{ labels: { namespace: 'other' } }, { labels: {} }] },
			} as any);
			expect(response.data.data).toEqual([{ labels: {} }]);
		} finally {
			setSelectedNamespace(null);
		}
	});
});
