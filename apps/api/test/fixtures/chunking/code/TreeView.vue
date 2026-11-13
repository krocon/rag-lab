<!-- Sample single-file component for the RAGLab code chunker golden test (self-written, MIT). -->
<template>
  <table class="tree-table">
    <tbody>
      <tr v-for="item in visible" :key="item.row.id" @click="toggle(item.row.id)">
        <td :style="{ paddingLeft: `${item.depth * indent}px` }">
          <span v-if="item.row.children?.length">{{ item.row.expanded ? '▾' : '▸' }}</span>
          {{ item.row.data.name }}
        </td>
      </tr>
    </tbody>
  </table>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { createTreeTableModel } from './tree-table';

interface Person {
  id: number;
  parentId?: number;
  name: string;
}

const props = defineProps<{ people: Person[]; indent?: number }>();

const model = ref(createTreeTableModel(props.people));
const indent = computed(() => props.indent ?? 16);
const visible = computed(() => model.value.visibleRows());

function toggle(id: number) {
  model.value.toggle(id);
}
</script>

<style scoped>
.tree-table {
  border-collapse: collapse;
  width: 100%;
}

.tree-table td {
  padding: 4px 8px;
  cursor: pointer;
}
</style>
