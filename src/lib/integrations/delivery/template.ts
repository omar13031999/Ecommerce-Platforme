/**
 * Tiny, safe templating used by the configurable REST adapter.
 * - A string that is exactly "{{field}}" is replaced by the raw value (number,
 *   boolean, array…), so numeric fields stay numeric.
 * - "{{field}}" inside a longer string is interpolated as text.
 * No code execution, no expressions.
 */
export function renderTemplate(template: unknown, vars: Record<string, unknown>): unknown {
  if (typeof template === 'string') {
    const whole = /^\{\{\s*([\w.]+)\s*\}\}$/.exec(template);
    if (whole) return getPath(vars, whole[1]!) ?? null;
    return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k: string) => {
      const v = getPath(vars, k);
      return v === null || v === undefined ? '' : String(v);
    });
  }
  if (Array.isArray(template)) return template.map((t) => renderTemplate(t, vars));
  if (template && typeof template === 'object') {
    return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, renderTemplate(v, vars)]));
  }
  return template;
}

/** Reads "a.b.0.c" from an object; returns undefined when absent. */
export function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) cur = cur[Number(part)];
    else if (typeof cur === 'object') cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}
