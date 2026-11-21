export function physicalLines(text) {
  return text.length === 0 ? 0 : text.split(/\r\n|\n|\r/).length - (/[\r\n]$/.test(text) ? 1 : 0);
}

export function budgetErrors(baseline, previous, measurements) {
  const errors = [];
  if (baseline.defaultMaxLines !== 800) errors.push("defaultMaxLines must remain 800.");
  for (const [file, budget] of Object.entries(baseline.moduleBudgets)) {
    if (
      !Number.isInteger(budget.baselineLines) ||
      budget.baselineLines < 0 ||
      budget.maxLines !== budget.baselineLines + 25
    )
      errors.push(`${file}: maxLines must equal baselineLines + 25.`);
    const old = previous?.moduleBudgets[file];
    if (previous && (!old || budget.baselineLines > old.baselineLines || budget.maxLines > old.maxLines))
      errors.push(`${file}: grandfathered budgets may not increase or be added.`);
    const actual = measurements.get(file);
    if (actual !== undefined && actual < budget.baselineLines)
      errors.push(`${file}: reduced to ${actual} lines; lower baselineLines and maxLines (or remove the exception).`);
  }
  return errors;
}
