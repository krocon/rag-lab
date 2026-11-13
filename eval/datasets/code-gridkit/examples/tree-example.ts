// Example: a tree table from nested rows (Gridkit, fictional, MIT).
import { Grid } from '../src/grid';
import { createTreeModel, type TreeRow } from '../src/tree/tree-model';

interface Person {
  name: string;
  role: string;
}

const rows: TreeRow<Person>[] = [
  {
    id: 1,
    data: { name: 'Ada', role: 'CEO' },
    expanded: true,
    children: [
      { id: 2, data: { name: 'Grace', role: 'CTO' } },
      { id: 3, data: { name: 'Linus', role: 'Engineer' } },
    ],
  },
];

const model = createTreeModel(rows, [
  { header: 'Name', value: (person) => person.name },
  { header: 'Role', value: (person) => person.role },
]);

new Grid(document.querySelector('#tree')!, model);
