const STORE_CHECK = /^(?:metadata|screenshots|categories|content_rights|age_rating|review_details|pricing|availability|agreements)\./;
const BLOCKER = /REJECTED|INVALID/;
const MAX_AGE = 72 * 60 * 60 * 1000;

function blockingChecks(report) {
  return Array.isArray(report?.checks) ? report.checks.filter((check) => check.severity === 'error') : [];
}

export function reviewRoutes(scan) {
  const candidate = scan.store?.data?.candidate;
  const validation = scan.review?.data;
  const checks = blockingChecks(validation);
  const store = checks.filter((check) => STORE_CHECK.test(check.id)).map(({ id, locale, field, resourceType }) =>
    ({ id, locale, field, resourceType }));
  return {
    candidate,
    store: candidate?.id && store.length ? store : [],
    triage: BLOCKER.test(candidate?.state ?? '') || Number(validation?.summary?.blocking ?? 0) > store.length,
    code: scan.compliance?.status === 'blocked',
  };
}

export function storeProof(task, scan, input, now) {
  const { approvalReference, evidence, observedAt, field, before, after } = input;
  const validText = (value) => typeof value === 'string' && value.trim().length > 0;
  const version = [scan?.store?.data?.candidate, scan?.store?.data?.live].find((item) => item?.id === task.storeVersionId);
  const time = Date.parse(observedAt);
  if (!task.storeVersionId || !version || scan.store.status !== 'ok' ||
    Date.parse(now) - Date.parse(scan.capturedAt) > MAX_AGE ||
    ![approvalReference, evidence, field, after].every(validText) ||
    /password|secret|token|private.key/i.test(field) ||
    typeof before !== 'string' || before === after || !Number.isFinite(time) ||
    time < Date.parse(task.createdAt) || time > Date.parse(now) ||
    input.versionId !== task.storeVersionId) {
    throw new Error('Use a fresh App Store scan, approved before/after values, observed date and matching App Store version ID');
  }
  if(task.plannedStoreChange) {
    const plan=task.plannedStoreChange;
    if(field!==plan.field||input.locale!==plan.locale||before!==plan.before||after!==plan.after||
      Date.parse(scan.capturedAt)<time) throw new Error('Verify the exact planned field, locale and before/after values with a fresh post-change scan');
  }
  if (task.storeChecks?.length) {
    const validation = scan.review?.data;
    const current = blockingChecks(validation);
    if (scan.review?.status !== 'ok' || validation?.versionId !== task.storeVersionId ||
      !Array.isArray(validation.checks) || !Number.isInteger(validation.summary?.blocking) ||
      validation.summary.blocking !== current.length || Date.parse(scan.capturedAt) < time ||
      task.storeChecks.some((check) => current.some((row) => row.id === check.id &&
        row.locale === check.locale && row.field === check.field))) {
      throw new Error('Re-run App Store validation after the change and confirm the original checks passed');
    }
  }
  return { field, before, after, observedAt, approvalReference, evidence, versionId: version.id };
}
