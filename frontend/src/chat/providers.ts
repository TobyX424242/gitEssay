/**
 * gitEssay — chat providers (LLM + local demo mock).
 *
 * Both implement ChatProvider.chat(ctx) → {text, edits}. The unified protocol is
 * coding-agent-style SEARCH/REPLACE: the model proposes targeted, reviewable
 * edits (never a whole-document replacement). The sidebar picks the live LLM
 * provider when AI is configured, else falls back to the deterministic mock so
 * the feature is always demonstrable.
 */
import type {AISettings} from '../rewrite/aiSettings';
import {callModel} from '../rewrite/llmClient';
import {detectMockAction, mockTransform} from '../rewrite/mockProvider';

import {parsePatches} from './patch';
import type {ChatContext, ChatProvider, ChatResponse} from './types';

export const PATCH_SYSTEM_PROMPT = [
  'You are an academic-writing assistant embedded in a rich-text editor.',
  'You help the user revise and discuss their text.',
  '',
  'When the user wants a change, propose it as one or more SEARCH/REPLACE blocks using EXACTLY this format:',
  '',
  '<<<<<<< SEARCH',
  '<the exact original text, copied verbatim from the document>',
  '=======',
  '<your replacement text>',
  '>>>>>>> REPLACE',
  '',
  'Rules:',
  '- Copy the SEARCH text VERBATIM from the document (enough surrounding context to be unique; keep it within a single paragraph or heading — do NOT span across paragraphs).',
  '- One block per change; you may emit several.',
  '- Any text OUTSIDE the blocks is shown to the user as your message/explanation.',
  '- If the user only asks a question or wants advice (no edit needed), reply in prose and emit NO blocks.',
  '- Preserve every citation marker (e.g. [1], (Smith, 2020)) and any LaTeX ($…$, $$…$$) verbatim in the REPLACE text.',
  '- Do NOT wrap the blocks in markdown code fences.',
  '- Match the document’s language.',
].join('\n');

function buildUserMessage(ctx: ChatContext): string {
  if (ctx.mode === 'selection' && ctx.selectionText) {
    return [
      'The user has selected this passage and wants to revise it:',
      '',
      '"""',
      ctx.selectionText,
      '"""',
      '',
      `Instruction: ${ctx.instruction}`,
      '',
      'Propose the change as a SEARCH/REPLACE block (SEARCH = the selected text, verbatim), or answer in prose if no edit is needed.',
    ].join('\n');
  }
  return [
    'Here is the current document:',
    '',
    '"""',
    ctx.documentText,
    '"""',
    '',
    `Instruction: ${ctx.instruction}`,
    '',
    'Propose changes as SEARCH/REPLACE block(s), or answer in prose if no edit is needed.',
  ].join('\n');
}

/** A ChatProvider bound to validated settings. */
export function createChatLLMProvider(s: AISettings): ChatProvider {
  return {
    id: 'llm',
    label: `AI · ${s.model}`,
    chat: async ctx => {
      const raw = await callModel(s, {
        system: PATCH_SYSTEM_PROMPT,
        user: buildUserMessage(ctx),
      });
      const {prose, edits} = parsePatches(raw);
      return {text: prose, edits};
    },
  };
}

/** Deterministic local demo (no key / no network). */
export const mockChatProvider: ChatProvider = {
  id: 'mock',
  label: 'AI · demo (local)',
  chat: ctx => {
    const action = detectMockAction(ctx.instruction);
    if (ctx.mode === 'selection' && ctx.selectionText && ctx.selectionText.trim()) {
      const replace = mockTransform(action, ctx.selectionText);
      const resp: ChatResponse = {
        text: `Here is a ${action} revision of your selection.`,
        edits: [{search: ctx.selectionText, replace}],
      };
      return Promise.resolve(resp);
    }
    const firstBlock =
      ctx.documentText.split(/\n\s*\n/).find(b => b.trim().length > 0) ?? '';
    if (!firstBlock) {
      return Promise.resolve({text: 'The document is empty — type something first.', edits: []});
    }
    const replace = mockTransform(action, firstBlock);
    return Promise.resolve({
      text: `I ${action}ed the opening passage:`,
      edits: [{search: firstBlock, replace}],
    });
  },
};

/** Active provider: live LLM when configured, else the local mock. */
export function getActiveChatProvider(
  configured: boolean,
  settings: AISettings,
): ChatProvider {
  return configured ? createChatLLMProvider(settings) : mockChatProvider;
}
