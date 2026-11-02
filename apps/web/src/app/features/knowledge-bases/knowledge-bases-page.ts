import { ChangeDetectionStrategy, Component } from '@angular/core';
import { PlannedFeature } from '../../shared/ui/planned-feature';

@Component({
  selector: 'rl-knowledge-bases-page',
  imports: [PlannedFeature],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Knowledge Bases</h1>
    <p class="rl-muted">Collections of documents that RAGLab indexes and searches.</p>
    <rl-planned-feature
      summary="Creating collections and uploading documents needs the domain model and ingestion pipeline first."
      prompt="prompts/009-angular-knowledge-ui.md"
      [capabilities]="[
        'Create, rename and delete knowledge bases',
        'Upload Markdown and text files',
        'Per-document indexing status (pending, processing, ready, failed) with error messages',
        'Chunk counts and embedding model per collection',
      ]"
    />
  `,
})
export class KnowledgeBasesPage {}
