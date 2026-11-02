import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/config/env.js';
import { DatasetError } from '../../src/eval/dataset.js';
import { EvalError } from '../../src/eval/evaluate.js';
import { describeFailure, parseCli } from '../../src/eval/run-eval.js';
import { AppError } from '../../src/http/errors.js';

describe('pnpm eval command line', () => {
  it('parses options with defaults (and ignores a "--" separator)', () => {
    const options = parseCli(['--', '--baseline', '--keep']);
    expect(options).toMatchObject({ baseline: true, keep: true, injection: false });
    expect(options !== 'help' && options.dataset.endsWith('eval/datasets/raglab-docs')).toBe(true);
    expect(options !== 'help' && options.out.endsWith('eval/results')).toBe(true);
    expect(parseCli(['-h'])).toBe('help');
  });

  it('rejects unknown options', () => {
    expect(() => parseCli(['--model', 'x'])).toThrow();
  });

  it('turns expected failures into one readable line without a stack trace', () => {
    expect(describeFailure(new EvalError('Ollama is not reachable.'))).toBe(
      'Ollama is not reachable.',
    );
    expect(describeFailure(new ConfigError(['EMBEDDING_MODEL: required']))).toContain(
      'EMBEDDING_MODEL',
    );
    expect(describeFailure(new DatasetError(['queries.jsonl:1: not valid JSON']))).toContain(
      'queries.jsonl:1',
    );
    expect(describeFailure(new AppError(409, 'EMBEDDING_MODEL_MISMATCH', 'Different model.'))).toBe(
      'EMBEDDING_MODEL_MISMATCH: Different model.',
    );
    expect(describeFailure(new Error('boom'))).toBe('Unexpected error: boom');
    try {
      parseCli(['--nope']);
    } catch (error) {
      expect(describeFailure(error)).toContain('Usage: pnpm eval');
    }
  });
});
