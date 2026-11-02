import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SystemStatus } from './system-status';

@Component({
  selector: 'rl-welcome-page',
  imports: [RouterLink, SystemStatus],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Welcome to RAGLab</h1>
    <p class="lead">
      An open-source workbench to build knowledge bases, search them semantically and ask questions
      with traceable sources – and to see exactly how the retrieval pipeline arrives at an answer.
    </p>

    <div class="grid">
      <rl-system-status />

      <section class="rl-card" aria-labelledby="getting-started-heading">
        <h2 id="getting-started-heading">Getting started</h2>
        <ol class="steps">
          <li>
            <strong>Create a knowledge base</strong> and upload Markdown or text files.
            <span class="rl-badge rl-badge--warn"><span aria-hidden="true">◷</span> Planned</span>
          </li>
          <li>
            <strong>Inspect retrieval</strong> in the
            <a routerLink="/playground">Retrieval Playground</a>: hits, scores and chunks.
            <span class="rl-badge rl-badge--warn"><span aria-hidden="true">◷</span> Planned</span>
          </li>
          <li>
            <strong>Ask questions</strong> in the <a routerLink="/chat">Chat</a> and verify every
            answer against its sources.
            <span class="rl-badge rl-badge--warn"><span aria-hidden="true">◷</span> Planned</span>
          </li>
          <li>
            <strong>Check the configuration</strong> of providers and models in
            <a routerLink="/settings">Settings</a>.
            <span class="rl-badge rl-badge--ok"><span aria-hidden="true">✓</span> Available</span>
          </li>
        </ol>
      </section>
    </div>
  `,
  styles: `
    .lead {
      max-width: 70ch;
      font-size: 1.05rem;
      margin-bottom: 1.5rem;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 1.25rem;
      align-items: start;
    }
    .steps {
      margin: 0;
      padding-left: 1.25rem;
      display: grid;
      gap: 0.75rem;
    }
    .steps .rl-badge {
      margin-left: 0.35rem;
    }
  `,
})
export class WelcomePage {}
