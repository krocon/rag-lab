/** Core contracts of Gridkit (fictional, MIT). */

/** Describes one column: its header and how to read the value from a row. */
export interface ColumnDef<T> {
  header: string;
  value: (row: T) => unknown;
  renderer?: import('./render/cell-renderer').CellRenderer<T>;
  width?: number;
}

/** What the grid needs to draw a table: columns, number of rows and the value of each cell. */
export interface TableModel<T> {
  columns: ColumnDef<T>[];
  rowCount(): number;
  cell(rowIndex: number, columnIndex: number): unknown;
  /** Horizontal indentation of a row in pixels (tree tables). */
  indent?(rowIndex: number): number;
}

/** A plain list of rows as a table model. */
export function createListModel<T>(rows: T[], columns: ColumnDef<T>[]): TableModel<T> {
  return {
    columns,
    rowCount: () => rows.length,
    cell: (rowIndex, columnIndex) => {
      const row = rows[rowIndex];
      const column = columns[columnIndex];
      return row !== undefined && column ? column.value(row) : undefined;
    },
  };
}
