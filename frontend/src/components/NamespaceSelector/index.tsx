import { useEffect, useMemo, useState } from 'react';
import { getFieldsValues } from 'api/generated/services/fields';
import { Select } from 'antd';
import {
	getSelectedNamespace,
	NAMESPACE_ATTRIBUTE,
	setSelectedNamespace,
} from 'utils/namespaceScope';

import './NamespaceSelector.styles.scss';

const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const SIGNALS = ['traces', 'logs', 'metrics'] as const;

async function fetchNamespaces(): Promise<string[]> {
	const endUnixMilli = Date.now();
	const startUnixMilli = endUnixMilli - LOOKBACK_MS;
	const results = await Promise.allSettled(
		SIGNALS.map((signal) =>
			getFieldsValues({
				signal: signal as any,
				name: NAMESPACE_ATTRIBUTE,
				fieldContext: 'resource' as any,
				startUnixMilli,
				endUnixMilli,
				limit: 200,
			}),
		),
	);
	const values = new Set<string>();
	results.forEach((result) => {
		if (result.status === 'fulfilled') {
			(result.value?.data?.values?.stringValues || []).forEach((value) => {
				if (value) {
					values.add(value);
				}
			});
		}
	});
	return Array.from(values).sort((a, b) => a.localeCompare(b));
}

// Rendered once by AppLayout as a bar above every page.
function NamespaceSelector(): JSX.Element {
	const [selected] = useState<string | null>(getSelectedNamespace);
	const [namespaces, setNamespaces] = useState<string[]>([]);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let cancelled = false;
		fetchNamespaces()
			.then((values) => {
				if (!cancelled) {
					setNamespaces(values);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setLoading(false);
				}
			});
		return (): void => {
			cancelled = true;
		};
	}, []);

	const options = useMemo(() => {
		const all = new Set(namespaces);
		if (selected) {
			all.add(selected);
		}
		return Array.from(all).map((value) => ({ label: value, value }));
	}, [namespaces, selected]);

	const onChange = (value?: string): void => {
		const next = value || null;
		if (next === selected) {
			return;
		}
		setSelectedNamespace(next);
		// Every cached query (react-query, redux, panels) was fetched under the old
		// scope; a reload is the only way to be sure nothing stale is shown.
		window.location.reload();
	};

	return (
		<div
			className={`namespace-selector ${selected ? 'is-scoped' : ''}`}
			data-testid="namespace-selector"
		>
			<span className="namespace-selector-label">Namespace</span>
			<Select
				size="small"
				allowClear
				showSearch
				loading={loading}
				value={selected ?? undefined}
				placeholder="All"
				options={options}
				onChange={onChange}
				popupMatchSelectWidth={false}
				className="namespace-selector-select"
			/>
		</div>
	);
}

export default NamespaceSelector;
