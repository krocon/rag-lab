/** Pivot tables of Gridkit (fictional, MIT). */
import type { TableModel } from '../table-model';

export type Aggregate = 'sum' | 'avg' | 'count' | 'min' | 'max';

/** How to pivot records: grouping fields for rows and columns, the measured field and aggregate. */
export interface PivotSpec<T> {
  rows: (keyof T)[];
  columns: (keyof T)[];
  value: keyof T;
  aggregate: Aggregate;
}

/** Aggregates a list of numbers. */
export function aggregate(values: number[], kind: Aggregate): number {
  if (values.length === 0) return 0;
  switch (kind) {
    case 'sum':
      return values.reduce((a, b) => a + b, 0);
    case 'avg':
      return values.reduce((a, b) => a + b, 0) / values.length;
    case 'count':
      return values.length;
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
  }
}

/**
 * Creates a pivot table model: one row per distinct combination of `spec.rows`, one column per
 * distinct combination of `spec.columns`, cells hold the aggregated `spec.value`.
 */
export function createPivotModel<T>(records: T[], spec: PivotSpec<T>): TableModel<string[]> {
  const key = (record: T, fields: (keyof T)[]) => fields.map((field) => String(record[field])).join(' / ');
  const rowKeys = [...new Set(records.map((record) => key(record, spec.rows)))].sort();
  const columnKeys = [...new Set(records.map((record) => key(record, spec.columns)))].sort();
  const cells = new Map<string, number[]>();
  for (const record of records) {
    const cellKey = `${key(record, spec.rows)}|${key(record, spec.columns)}`;
    cells.set(cellKey, [...(cells.get(cellKey) ?? []), Number(record[spec.value])]);
  }
  return {
    columns: [
      { header: spec.rows.join(' / '), value: (row) => row[0] },
      ...columnKeys.map((columnKey, index) => ({ header: columnKey, value: (row: string[]) => row[index + 1] })),
    ],
    rowCount: () => rowKeys.length,
    cell: (rowIndex, columnIndex) => {
      const rowKey = rowKeys[rowIndex] ?? '';
      if (columnIndex === 0) return rowKey;
      const values = cells.get(`${rowKey}|${columnKeys[columnIndex - 1]}`) ?? [];
      return aggregate(values, spec.aggregate);
    },
  };
}
