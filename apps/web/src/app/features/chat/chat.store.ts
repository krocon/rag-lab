import { Injectable, computed, inject, signal } from '@angular/core';
import type { ChatDoneEvent, ChatSource } from '@raglab/shared';
import { ApiRequestError, toApiRequestError } from '../../core/api/api-error';
import { ChatApi } from '../../core/api/chat-api';
import { isAbortError } from '../../core/api/sse-client';

/**
 * Life cycle of one answer: `retrieving` (request sent, no event yet) → `streaming` (sources
 * received, tokens arriving) → `done` | `error` | `aborted`.
 */
export type TurnStatus = 'retrieving' | 'streaming' | 'done' | 'error' | 'aborted';

/**
 * Where an answer failed – each is shown differently:
 * - `request`: the API rejected the question before the stream (`400`, `404`, `409`, `502`, `503`).
 * - `stream`: the API reported an `error` event (chat model unavailable/failed).
 * - `network`: the API was not reachable at all.
 * - `interrupted`: the connection broke (or the stream ended) before `done`/`error`.
 */
export type TurnErrorKind = 'request' | 'stream' | 'network' | 'interrupted';

export interface TurnError {
  kind: TurnErrorKind;
  code: string;
  message: string;
  /** HTTP status for `request` errors, otherwise `0`. */
  status: number;
}

export interface ChatCollectionRef {
  id: string;
  name: string;
}

/**
 * One question and its answer. State lives in signals per turn, so a token only updates its own
 * message – the conversation list itself changes only when a turn is added or removed.
 */
export class ChatTurn {
  readonly status = signal<TurnStatus>('retrieving');
  /** Answer text: the `token` events appended in order. */
  readonly answer = signal('');
  /** `null` until the `sources` event arrived. */
  readonly sources = signal<readonly ChatSource[] | null>(null);
  readonly done = signal<ChatDoneEvent | null>(null);
  readonly error = signal<TurnError | null>(null);

  readonly noSources = computed(() => this.done()?.answerStatus === 'no_sources');
  readonly active = computed(() => {
    const status = this.status();
    return status === 'retrieving' || status === 'streaming';
  });

  constructor(
    readonly id: number,
    readonly question: string,
    readonly collection: ChatCollectionRef,
  ) {}

  reset(): void {
    this.status.set('retrieving');
    this.answer.set('');
    this.sources.set(null);
    this.done.set(null);
    this.error.set(null);
  }
}

export const INCOMPLETE_STREAM_MESSAGE =
  'The answer stream ended before it was complete. The API may have been restarted.';

/**
 * Conversation of the current browser session – in memory only (no server history, nothing in
 * storage). Root-provided, so the conversation survives following a source link to a document and
 * coming back; a reload clears it. One answer streams at a time; every question is sent on its
 * own (the API has no multi-turn context).
 */
@Injectable({ providedIn: 'root' })
export class ChatStore {
  private readonly api = inject(ChatApi);
  private nextId = 1;

  private readonly turnList = signal<readonly ChatTurn[]>([]);
  private readonly running = signal<{ turn: ChatTurn; controller: AbortController } | null>(null);

  readonly turns = this.turnList.asReadonly();
  readonly busy = computed(() => this.running() !== null);
  /** Last selected knowledge base (restores the selection when coming back to `/chat`). */
  readonly lastCollectionId = signal<string | undefined>(undefined);
  /**
   * Text for a polite live region: start, sources, end, cancel – never single tokens, so screen
   * readers are not flooded while the answer streams.
   */
  readonly announcement = signal('');

  /** Starts a new answer; ignored while another one is streaming or for a blank question. */
  send(collection: ChatCollectionRef, question: string): ChatTurn | undefined {
    const text = question.trim();
    if (this.busy() || text.length === 0) {
      return undefined;
    }
    const turn = new ChatTurn(this.nextId++, text, collection);
    this.turnList.update((turns) => [...turns, turn]);
    void this.run(turn);
    return turn;
  }

  /** Asks the question of a finished (failed, cancelled, answered) turn again, in place. */
  retry(turn: ChatTurn): void {
    if (this.busy() || !this.turnList().includes(turn)) {
      return;
    }
    turn.reset();
    void this.run(turn);
  }

  /** Cancels the streaming answer immediately; the partial answer is kept and marked. */
  cancel(): void {
    const running = this.running();
    if (!running) {
      return;
    }
    this.running.set(null);
    running.controller.abort();
    running.turn.status.set('aborted');
    this.announce('Answer cancelled.');
  }

  /** "New chat": cancels a running answer and forgets the conversation. */
  clear(): void {
    const running = this.running();
    if (running) {
      this.running.set(null);
      running.controller.abort();
    }
    this.turnList.set([]);
    this.announce('Started a new chat.');
  }

  private async run(turn: ChatTurn): Promise<void> {
    const controller = new AbortController();
    this.running.set({ turn, controller });
    this.announce('Question sent. Searching sources…');
    const current = () => !controller.signal.aborted;
    let ended = false;
    try {
      const events = this.api.streamChat(
        { collectionId: turn.collection.id, question: turn.question },
        controller.signal,
      );
      for await (const event of events) {
        if (!current()) {
          return;
        }
        switch (event.event) {
          case 'sources':
            turn.sources.set(event.data.sources);
            turn.status.set('streaming');
            if (event.data.sources.length > 0) {
              this.announce(`${countSources(event.data.sources.length)} found. Generating answer…`);
            }
            break;
          case 'token':
            turn.answer.update((answer) => answer + event.data.text);
            break;
          case 'done':
            ended = true;
            turn.done.set(event.data);
            turn.status.set('done');
            this.announce(doneAnnouncement(event.data));
            break;
          case 'error':
            ended = true;
            turn.error.set({ kind: 'stream', status: 0, ...event.data });
            turn.status.set('error');
            break;
        }
        if (ended) {
          break;
        }
      }
      if (!ended && current()) {
        this.fail(turn, {
          kind: 'interrupted',
          code: 'STREAM_INTERRUPTED',
          message: INCOMPLETE_STREAM_MESSAGE,
          status: 0,
        });
      }
    } catch (error) {
      if (!current() || isAbortError(error)) {
        return;
      }
      this.fail(turn, toTurnError(error));
    } finally {
      if (this.running()?.controller === controller) {
        this.running.set(null);
      }
    }
  }

  private fail(turn: ChatTurn, error: TurnError): void {
    turn.error.set(error);
    turn.status.set('error');
  }

  private announce(message: string): void {
    // Repeating the same text would not be announced again: vary it invisibly.
    this.announcement.update((previous) => (previous === message ? `${message}\u00a0` : message));
  }
}

export function toTurnError(error: unknown): TurnError {
  const apiError = error instanceof ApiRequestError ? error : toApiRequestError(error);
  const { code, status } = apiError;
  const issues = apiError.validationIssues.map((issue) => `${issue.location} ${issue.message}`);
  const message =
    issues.length > 0 ? `${apiError.message}: ${issues.join('; ')}.` : apiError.message;
  if (code === 'STREAM_INTERRUPTED' || code === 'INVALID_STREAM') {
    return { kind: 'interrupted', code, message, status: 0 };
  }
  if (status === 0 || code === 'NETWORK_ERROR') {
    return { kind: 'network', code, message, status };
  }
  return { kind: 'request', code, message, status };
}

function countSources(count: number): string {
  return `${count} ${count === 1 ? 'source' : 'sources'}`;
}

function doneAnnouncement(done: ChatDoneEvent): string {
  if (done.answerStatus === 'no_sources') {
    return 'No matching sources found. The question was not sent to the model.';
  }
  const cited =
    done.citedSources.length > 0
      ? `Cites ${done.citedSources.length === 1 ? 'source' : 'sources'} ${done.citedSources.join(', ')}.`
      : 'It cites no source.';
  return `Answer complete. ${cited}`;
}
