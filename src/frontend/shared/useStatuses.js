/**
 * Hook: load Test statuses for a list of Test ids and a scope, in as few
 * resolver calls as possible (one per 500 Tests).
 */
import { useCallback, useEffect, useState } from 'react';
import { LIMITS } from '../../shared/constants';
import { callResolver, errorMessage } from './api';

export async function fetchStatuses(testIds, scope) {
  const statuses = {};
  for (let index = 0; index < testIds.length; index += LIMITS.STATUS_IDS_MAX) {
    const chunk = testIds.slice(index, index + LIMITS.STATUS_IDS_MAX);
    const result = await callResolver('getStatuses', { testIssueIds: chunk, scope });
    Object.assign(statuses, result.statuses);
  }
  return statuses;
}

/**
 * @param {string[] | null} testIds - null while the ids are still loading
 * @param {object} scope - { kind: 'latest' } or { kind: 'plan', id, environment }
 */
export function useStatuses(testIds, scope) {
  const [statuses, setStatuses] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // Stable dependency keys so a new array with the same ids doesn't refetch.
  const idsKey = testIds ? testIds.join(',') : null;
  const scopeKey = JSON.stringify(scope);

  const reload = useCallback(async () => {
    if (idsKey === null) return;
    const ids = idsKey ? idsKey.split(',') : [];
    if (ids.length === 0) {
      setStatuses({});
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setStatuses(await fetchStatuses(ids, JSON.parse(scopeKey)));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [idsKey, scopeKey]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { statuses, loading, error, reload };
}
