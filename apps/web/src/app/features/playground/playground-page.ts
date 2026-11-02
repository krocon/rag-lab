import { ChangeDetectionStrategy, Component } from '@angular/core';
import { PlannedFeature } from '../../shared/ui/planned-feature';

@Component({
  selector: 'rl-playground-page',
  imports: [PlannedFeature],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Retrieval Playground</h1>
    <p class="rl-muted">
      Inspect what the retriever finds for a query – before an LLM is involved.
    </p>
    <rl-planned-feature
      summary="The playground uses the same retrieval service as the chat, so results here are exactly what the chat would use."
      prompt="prompts/011-retrieval-playground.md"
      [capabilities]="[
        'Query a collection with configurable top-K',
        'Ranked hits with cosine distance and score (1 − distance)',
        'Chunk preview with heading path and offsets',
      ]"
    />
  `,
})
export class PlaygroundPage {}
