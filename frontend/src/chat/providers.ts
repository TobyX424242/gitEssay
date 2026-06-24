/**
 * gitEssay — chat providers.
 *
 * The sidebar uses the live LLM provider when AI is configured. If the API call
 * fails (bad key / URL / model, network, non-OK response) callModel throws and
 * the sidebar surfaces an error — it never fabricates an accept/reject. When AI
 * is NOT configured, the provider throws a clear "not configured" error as well
 * (no silent demo fallback that would present the user's own text as output).
 *
 * Edits are sanitized: a no-op edit (replace === search) is dropped, so the UI
 * never asks the user to "accept" their own unchanged text.
 */
import type {AISettings} from '../rewrite/aiSettings';
import {callModel} from '../rewrite/llmClient';

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

/** Drop no-op edits (replace unchanged) so we never offer the user's own text as a change. */
function sanitize(resp: ChatResponse): ChatResponse {
  const edits = resp.edits.filter(e => e.replace.trim() !== e.search.trim());
  const text =
    edits.length === 0 && !resp.text.trim() ? 'No changes to apply.' : resp.text;
  return {text, edits};
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
      return sanitize(parsePatches(raw));
    },
  };
}

/** Not configured: always errors so the user is told to set up the API. */
export function unconfiguredChatProvider(): ChatProvider {
  return {
    id: 'unconfigured',
    label: 'AI · not configured',
    chat: async () => {
      throw new Error(
        'AI is not configured. Open the ⚙ settings to set your provider, API key, and model.',
      );
    },
  };
}

/** Active provider: live LLM when configured, else an error-throwing provider. */
export function getActiveChatProvider(
  configured: boolean,
  settings: AISettings,
): ChatProvider {
  return configured ? createChatLLMProvider(settings) : unconfiguredChatProvider();
}
