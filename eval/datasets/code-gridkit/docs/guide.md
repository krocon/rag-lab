# Gridkit guide

## Tree tables

A tree table shows rows that have child rows. Every row object must have a unique `id` and may
have a `children` array with rows of the same shape. Rows start collapsed unless `expanded` is
`true`. Build the model with `createTreeModel(rows, columns)` and pass it to `new Grid(element,
model)`. If your data is flat with a `parentId` column, convert it with `treeFromParentIds` first.

## Pivot tables

A pivot table groups records by row and column keys and aggregates a value. Describe it with a
`PivotSpec`: `rows` and `columns` name the grouping fields, `value` the measured field and
`aggregate` one of `sum`, `avg`, `count`, `min`, `max`. `createPivotModel(records, spec)` returns
a table model with one header row per column key.

## Cell renderers

A cell renderer controls how a cell looks. Implement the `CellRenderer` interface: its `render`
method receives the cell element, the value and the row, and writes text or child elements. Never
assign untrusted values to `innerHTML`; use `textContent`. Register a renderer per column with
`column.renderer`.

## Footer rows

A footer row shows aggregates below the body, for example totals. Add a `footer` entry to the
grid options with one `FooterCell` per column; `aggregate: 'sum'` adds the column's numbers.
