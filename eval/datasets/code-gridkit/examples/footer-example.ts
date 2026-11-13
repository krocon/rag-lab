// Example: a footer row with totals (Gridkit, fictional, MIT).
import { Grid } from '../src/grid';
import { createListModel } from '../src/table-model';

const sales = [
  { region: 'North', revenue: 1200 },
  { region: 'South', revenue: 800 },
];

const model = createListModel(sales, [
  { header: 'Region', value: (row) => row.region },
  { header: 'Revenue', value: (row) => row.revenue },
]);

new Grid(document.querySelector('#sales')!, model, {
  footer: [{ label: 'Total' }, { aggregate: 'sum' }],
});
