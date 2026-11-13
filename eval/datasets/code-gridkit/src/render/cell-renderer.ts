/** Cell renderers of Gridkit (fictional, MIT). */

/**
 * Draws one cell. `render` receives the cell element, the cell value and the whole row. Write
 * text with `textContent` – never assign untrusted values to `innerHTML`.
 */
export interface CellRenderer<T> {
  render(cell: HTMLElement, value: unknown, row: T): void;
}

/** Default renderer: the value as text. */
export const textRenderer: CellRenderer<unknown> = {
  render(cell, value) {
    cell.textContent = value == null ? '' : String(value);
  },
};

/** Example of a custom cell renderer: a number with a currency and a CSS class for negatives. */
export class CurrencyRenderer implements CellRenderer<unknown> {
  constructor(private readonly currency = 'EUR') {}

  render(cell: HTMLElement, value: unknown): void {
    const amount = Number(value);
    cell.textContent = new Intl.NumberFormat('en', { style: 'currency', currency: this.currency }).format(amount);
    cell.classList.toggle('gk-negative', amount < 0);
  }
}
