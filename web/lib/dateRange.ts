export type Range = { from: string; to: string };

export const HISTORY_DAYS = 90;

const parse = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};

export const fmtIso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const addDays = (s: string, n: number) => {
  const d = parse(s);
  d.setDate(d.getDate() + n);
  return fmtIso(d);
};

export const daysBetween = (a: string, b: string) => Math.round((parse(b).getTime() - parse(a).getTime()) / 86400000) + 1;

export const presetRange = (days: number, maxIso: string): Range => ({ from: addDays(maxIso, -(days - 1)), to: maxIso });

/** 与当前区间等长、紧邻其前的对比区间 */
export const prevRange = (r: Range): Range => {
  const n = daysBetween(r.from, r.to);
  return { from: addDays(r.from, -n), to: addDays(r.from, -1) };
};

export const pick = <T extends { iso: string }>(rows: T[], r: Range) => rows.filter((x) => x.iso >= r.from && x.iso <= r.to);

export const minIsoOf = (maxIso: string) => addDays(maxIso, -(HISTORY_DAYS - 1));
