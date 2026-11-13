/** Footer rows of Gridkit (fictional, MIT). */
import { aggregate, type Aggregate } from '../pivot/pivot-model';
import type { TableModel } from '../table-model';

/** One cell of the footer row: a fixed label or an aggregate of the column's numbers. */
export interface FooterCell {
  label?: string;
  aggregate?: Aggregate;
}

/** Computes the footer values, e.g. totals with `{ aggregate: 'sum' }` per numeric column. */
export function computeFooter<T>(model: TableModel<T>, footer: FooterCell[]): (string | number)[] {
  return footer.map((cell, columnIndex) => {
    if (cell.aggregate === undefined) return cell.label ?? '';
    const values: number[] = [];
    for (let rowIndex = 0; rowIndex < model.rowCount(); rowIndex++) {
      const value = Number(model.cell(rowIndex, columnIndex));
      if (Number.isFinite(value)) values.push(value);
    }
    return aggregate(values, cell.aggregate);
  });
}
