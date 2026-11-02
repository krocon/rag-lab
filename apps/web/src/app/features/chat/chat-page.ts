import { ChangeDetectionStrategy, Component } from '@angular/core';
import { PlannedFeature } from '../../shared/ui/planned-feature';

@Component({
  selector: 'rl-chat-page',
  imports: [PlannedFeature],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Chat</h1>
    <p class="rl-muted">Ask questions about a knowledge base and get answers with sources.</p>
    <rl-planned-feature
      summary="The chat needs retrieval and a configured chat model. Answers will only cite passages that were actually retrieved."
      prompt="prompts/010-angular-chat-ui.md"
      [capabilities]="[
        'Streaming answers (Server-Sent Events)',
        'Source cards with document, chunk and score',
        'Open the exact passage an answer is based on',
        'Clear error states when a provider or model is unavailable',
      ]"
    />
  `,
})
export class ChatPage {}
