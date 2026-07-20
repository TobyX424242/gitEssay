import {describe, it, expect} from 'vitest';

import {buildRetryPlan, lifoRevertSteps} from '../retry';
import type {ChatEditState, ChatMessage} from '../types';

const user = (id: string, text: string, context?: ChatMessage['context']): ChatMessage => ({
  id,
  role: 'user',
  text,
  context,
});

const assistant = (
  id: string,
  edits: Array<{search: string; replace: string; state: ChatEditState}> = [],
  explanation?: string,
): ChatMessage => ({
  id,
  role: 'assistant',
  text: 'prose',
  action: explanation ? {kind: 'patch', explanation} : null,
  edits,
});

const applied = (n: number) => ({search: `s${n}`, replace: `r${n}`, state: 'applied' as const});

describe('buildRetryPlan', () => {
  it('returns null for an unknown or first message target', () => {
    const msgs = [user('u1', 'do it'), assistant('a1')];
    expect(buildRetryPlan(msgs, 'nope')).toBeNull();
    expect(buildRetryPlan(msgs, 'u1')).toBeNull(); // idx 0 — no preceding user turn
  });

  it('returns null when the preceding message is not a user turn', () => {
    const msgs = [user('u1', 'x'), assistant('a1'), assistant('a2')];
    expect(buildRetryPlan(msgs, 'a2')).toBeNull();
  });

  it('captures instruction/mode/selection from the preceding user message', () => {
    const msgs = [
      user('u1', 'tighten this', {mode: 'selection', selectionText: 'sel'}),
      assistant('a1'),
    ];
    const plan = buildRetryPlan(msgs, 'a1');
    expect(plan).not.toBeNull();
    expect(plan!.instruction).toBe('tighten this');
    expect(plan!.mode).toBe('selection');
    expect(plan!.selectionText).toBe('sel');
    expect(plan!.priorMessages).toEqual([]);
  });

  it('defaults the mode to document when the user message has no context', () => {
    const plan = buildRetryPlan([user('u1', 'go'), assistant('a1')], 'a1');
    expect(plan!.mode).toBe('document');
    expect(plan!.selectionText).toBeUndefined();
  });

  it('collects only applied edits from the target onward (earlier turns untouched)', () => {
    const msgs = [
      user('u0', 'first'),
      assistant('a0', [applied(0)], 'v0'), // before target — never reverted
      user('u1', 'second'),
      assistant('a1', [applied(1), {search: 'x', replace: 'y', state: 'rejected'}], 'v1'),
      assistant('a2', [applied(2)], 'v2'), // later turn — included
    ];
    const plan = buildRetryPlan(msgs, 'a1');
    expect(plan!.items.map(it => it.msgId)).toEqual(['a1', 'a2']); // chronological
    expect(plan!.items[0].count).toBe(1); // rejected edit excluded
    expect(plan!.items[0].label).toBe('v1');
    expect(plan!.totalEdits).toBe(2);
    expect(plan!.priorMessages.map(m => m.id)).toEqual(['u0', 'a0']);
  });

  it('reverts legacy messages (edits but no action) with a generic label', () => {
    const legacy: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      text: 'old',
      edits: [applied(1)],
    };
    const plan = buildRetryPlan([user('u1', 'go'), legacy], 'a1');
    expect(plan!.items).toEqual([{msgId: 'a1', label: 'AI edit', count: 1}]);
  });

  it('skips assistant turns with nothing applied', () => {
    const msgs = [
      user('u1', 'go'),
      assistant('a1', [{search: 's', replace: 'r', state: 'pending'}], 'v1'),
      assistant('a2'), // advice-only turn
    ];
    const plan = buildRetryPlan(msgs, 'a1');
    expect(plan!.items).toEqual([]);
    expect(plan!.totalEdits).toBe(0);
  });
});

describe('lifoRevertSteps', () => {
  it('reverts latest response first, and latest edit first within a response', () => {
    const msgs = [
      user('u1', 'go'),
      assistant('a1', [applied(1), applied(2)], 'v1'),
      assistant('a2', [applied(3), applied(4)], 'v2'),
    ];
    const plan = buildRetryPlan(msgs, 'a1')!;
    const steps = lifoRevertSteps(plan);
    expect(steps.map(s => `${s.msgId}#${s.editIndex}`)).toEqual([
      'a2#1',
      'a2#0',
      'a1#1',
      'a1#0',
    ]);
    expect(steps.map(s => s.edit.search)).toEqual(['s4', 's3', 's2', 's1']);
  });

  it('only steps over edits still in applied state', () => {
    const msgs = [
      user('u1', 'go'),
      assistant('a1', [applied(1), {search: 's2', replace: 'r2', state: 'reverted'}], 'v1'),
    ];
    const steps = lifoRevertSteps(buildRetryPlan(msgs, 'a1')!);
    expect(steps).toHaveLength(1);
    expect(steps[0].editIndex).toBe(0);
  });

  it('skips items whose message is missing from the snapshot', () => {
    const plan = buildRetryPlan([user('u1', 'go'), assistant('a1', [applied(1)], 'v1')], 'a1')!;
    plan.items.push({msgId: 'ghost', label: 'x', count: 1});
    expect(lifoRevertSteps(plan)).toHaveLength(1);
  });
});
