export const money = (v: unknown): string =>
  v == null || v === '' ? '-' : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const pct = (v: unknown): string => (v == null || v === '' ? '-' : (Number(v) * 100).toFixed(1) + '%');

export const int = (v: unknown): string => (v == null || v === '' ? '-' : Number(v).toLocaleString('en-US'));