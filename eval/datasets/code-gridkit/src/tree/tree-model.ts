/**
 * Tree table model of Gridkit (fictional library for the RAGLab code evaluation, MIT).
 */
import type { ColumnDef, TableModel } from '../table-model';

/** One row of a tree table: a unique id, the cell values and optional child rows. */
export interface TreeRow<T> {
  id: string | number;
  data: T;
  children?: TreeRow<T>[];
  expanded?: boolean;
}

/** Flat record with a reference to its parent, e.g. a database row. */
export interface ParentIdRecord {
  id: string | number;
  parentId?: string | number | null;
}

/**
 * Builds a tree table model. Rows start collapsed unless `expanded` is true; only rows of
 * expanded parents are visible.
 */
export function createTreeModel<T>(rows: TreeRow<T>[], columns: ColumnDef<T>[]): TableModel<T> {
  const visible = (): { row: TreeRow<T>; depth: number }[] => {
    const result: { row: TreeRow<T>; depth: number }[] = [];
    const walk = (level: TreeRow<T>[], depth: number) => {
      for (const row of level) {
        result.push({ row, depth });
        if (row.expanded && row.children?.length) {
          walk(row.children, depth + 1);
        }
      }
    };
    walk(rows, 0);
    return result;
  };
  return {
    columns,
    rowCount: () => visible().length,
    cell: (rowIndex, columnIndex) => {
      const entry = visible()[rowIndex];
      const column = columns[columnIndex];
      return entry && column ? column.value(entry.row.data) : undefined;
    },
    indent: (rowIndex) => (visible()[rowIndex]?.depth ?? 0) * 16,
  };
}

/** Converts flat records with `parentId` into nested tree rows (roots have no parent). */
export function treeFromParentIds<T extends ParentIdRecord>(records: T[]): TreeRow<T>[] {
  const byId = new Map<T['id'], TreeRow<T>>();
  for (const record of records) {
    byId.set(record.id, { id: record.id, data: record, children: [] });
  }
  const roots: TreeRow<T>[] = [];
  for (const record of records) {
    const row = byId.get(record.id);
    const parent = record.parentId == null ? undefined : byId.get(record.parentId);
    if (row) {
      (parent?.children ?? roots).push(row);
    }
  }
  return roots;
}
