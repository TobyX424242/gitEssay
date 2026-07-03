/**
 * gitEssay — streaming agent loop (the sidebar AI surface).
 *
 * Replaces the old single-shot ChatProvider. `runAgent` drives a real agent loop:
 * each turn streams the model's <thinking> + <action>; a non-terminal read/search
 * action is executed against the live Lexical document and fed back as a tool
 * result, looping until a terminal action (patch / ask / finish) or a pure-prose
 * reply. The backend (/api/chat/stream) is a thin normalized streaming gateway;
 * all document access + loop control lives here (the doc is in the editor, not
 * the backend).
 *
 * Thinking is portable: the prompt asks for <thinking> tags (works on every
 * model/gateway), and native reasoning_content / Anthropic thinking deltas are
 * forwarded by the backend and PREFERRED when present (so reasoning models show
 * real native thinking; others fall back to the tagged prose).
 */
import {$getRoot, type LexicalEditor} from 'lexical';

import {streamChat, type ChatTurn} from '../rewrite/llmClient';
import {
  actionEdits,
  extractPartialAction,
  extractRememberAction,
  extractThinking,
  extractToolAction,
  parseTurn,
  stripMarkup,
} from './patch';
import type {
  AgentStep,
  AssistantAction,
  ChatEditState,
  ChatMessage,
  ChatMode,
} from './types';

const MAX_TURNS = 5;
const READ_CHAR_CAP = 24000; // cap a read result so huge docs don't blow context
const SEARCH_MATCH_CAP = 12;
const MEMORY_NOTE_CAP = 20; // max notes injected into the system prompt
const MEMORY_CHAR_CAP = 6000; // cap total injected memory chars

export interface InjectedMemory {
  content: string;
}

/**
 * Build the agent system prompt. When long-term memory is enabled, the project's
 * notes are injected as a background section and the `remember` action is added;
 * when disabled, the prompt says memory is off and forbids `remember`.
 */
export function buildSystemPrompt(opts: {
  memoryEnabled: boolean;
  memories: InjectedMemory[];
}): string {
  const lines: string[] = [
    'You are an academic-writing agent embedded in a rich-text editor. You help the user revise, expand, and discuss their text. You behave like a focused coding agent: think, then act.',
    '',
    'EVERY reply MUST use this exact shape:',
    '  1. A <thinking>...</thinking> block with your step-by-step reasoning (what the user wants, what you need to check, your plan). This is shown live to the user in a collapsible pane, so keep it concise and useful — not a wall of text.',
    '  2. Exactly ONE <action>{ json }</action> block (or, for a plain conversational answer, just prose with no action block at all).',
    '',
    'Action kinds (emit one <action> with a JSON object):',
    '  {"kind":"read"}                         — re-read the full document (use if you are unsure where text lives).',
    '  {"kind":"read","query":"..."}           — read only paragraphs containing the query.',
    '  {"kind":"search","query":"..."}         — find paragraphs containing the query (case-insensitive).',
  ];
  if (opts.memoryEnabled) {
    lines.push(
      '  {"kind":"remember","note":"..."}        — save a DURABLE note about this project to long-term memory (a stable preference, convention, decision, or fact the user would want you to recall next time). Use it sparingly — never for transient task state or the current edit.',
    );
  }
  lines.push(
    '  {"kind":"patch","explanation":"...","edits":[{"search":"...","replace":"..."}]}',
    '                                          — propose edits. `explanation` is REQUIRED and becomes the version label for this edit (like a commit message: one short imperative line, e.g. "Tighten topic sentence"). `search` is copied VERBATIM from the document (enough context to be unique, within ONE paragraph — never across paragraphs); you may emit several edits. Preserve every citation marker ([1], (Smith, 2020)) and LaTeX ($...$, $$...$$) verbatim. Do NOT wrap anything in markdown code fences.',
    '  {"kind":"ask","question":"...","options":["...","..."]}',
    '                                          — ask the user a clarifying question with concrete options. The UI always appends a free-text choice, so do NOT add an "Other" option yourself. Use this whenever the request is ambiguous and the answer changes what you do.',
    '  {"kind":"finish","summary":"..."}       — you are done; summarize briefly what you did (or did not) change.',
    '',
  );

  if (opts.memoryEnabled) {
    lines.push(
      'Project memory — your running notes about this project, kept across conversations (treat as background context):',
    );
    const notes: string[] = [];
    let budget = MEMORY_CHAR_CAP;
    for (const m of opts.memories) {
      const c = m.content.trim();
      if (!c) {
        continue;
      }
      if (notes.length >= MEMORY_NOTE_CAP || budget <= 0) {
        break;
      }
      notes.push(c);
      budget -= c.length;
    }
    if (notes.length > 0) {
      notes.forEach(n => lines.push(`- ${n}`));
    } else {
      lines.push('- (none yet)');
    }
    lines.push(
      'Only add a new note with `remember` when you learn something genuinely worth keeping. Do not re-save what is already listed.',
      '',
    );
  } else {
    lines.push('Long-term memory is currently OFF — do not use the remember action.', '');
  }

  lines.push(
    'How to work:',
    '- For a simple edit on text you can already see, go straight to patch.',
    '- If you need to locate or verify text first, use read/search, then act on the result.',
    '- Never fabricate document content. If you cannot find the passage, search/read again or ask.',
    '- Stop as soon as the goal is met (finish) or you need a decision (ask). Do not loop unnecessarily.',
    '- Reply in the document\'s language. Outside the <thinking> and <action> blocks, write only the prose you want the user to read.',
  );
  return lines.join('\n');
}

// --- document access (synchronous reads against the live editor) -----------
interface DocView {
  paragraphs: string[];
  full: string;
}

function readDoc(editor: LexicalEditor): DocView {
  let paragraphs: string[] = [];
  editor.getEditorState().read(() => {
    paragraphs = $getRoot()
      .getChildren()
      .map(b => b.getTextContent());
  });
  return {paragraphs, full: paragraphs.join('\n\n')};
}

function cap(text: string, limit: number): string {
  return text.length > limit
    ? `${text.slice(0, limit)}\n\n[…truncated, ${text.length - limit} more chars…]`
    : text;
}

function filterParagraphs(paragraphs: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return paragraphs;
  }
  return paragraphs.filter(p => p.toLowerCase().includes(q));
}

/** Read result framed as a tool message the model can act on. */
function frameRead(view: DocView, query?: string): {text: string; hits: number} {
  if (query && query.trim()) {
    const matches = filterParagraphs(view.paragraphs, query).slice(0, SEARCH_MATCH_CAP);
    const body =
      matches.length > 0
        ? matches.map((p, i) => `${i + 1}. ${p}`).join('\n\n')
        : '(no paragraphs matched)';
    return {text: cap(body, READ_CHAR_CAP), hits: matches.length};
  }
  return {text: cap(view.full || '(empty document)', READ_CHAR_CAP), hits: view.paragraphs.length};
}

// --- history mapping -------------------------------------------------------
/**
 * Prior stored messages → the {role, content} turns sent to the model. Assistant
 * turns carry a compact note of the action taken so the model has context across
 * a multi-message conversation (e.g. resuming after it asked a question).
 */
export function messagesToHistory(messages: ChatMessage[]): ChatTurn[] {
  return messages.map(m => {
    if (m.role === 'user') {
      return {role: 'user', content: m.text};
    }
    const parts: string[] = [];
    if (m.text?.trim()) {
      parts.push(m.text.trim());
    }
    const a = m.action;
    if (a?.kind === 'patch') {
      parts.push(`[Proposed ${(m.edits ?? []).length} edit(s): "${a.explanation}"]`);
    } else if (a?.kind === 'ask') {
      parts.push(`[Asked the user: "${a.question}"]`);
    } else if (a?.kind === 'finish') {
      parts.push(`[Finished: ${a.summary ?? ''}]`);
    }
    if (m.error) {
      parts.push(`[Error: ${m.error}]`);
    }
    return {role: 'assistant', content: parts.join('\n\n') || '(no content)'};
  });
}

// --- the loop --------------------------------------------------------------
export interface RunAgentOpts {
  editor: LexicalEditor;
  instruction: string;
  mode: ChatMode;
  /** selection text captured at send time (mode === 'selection'). */
  selectionText?: string;
  /** prior conversation turns (already mapped via messagesToHistory). */
  history: ChatTurn[];
  signal: AbortSignal;
  /** live deltas for the streaming message bubble. */
  onUpdate: (patch: Partial<ChatMessage>) => void;
  /** Long-term memory: notes injected into the prompt (when enabled). */
  memoryEnabled: boolean;
  memories: InjectedMemory[];
  /** Persist a `remember` note (called when the agent emits a remember action). */
  onRemember?: (note: string) => Promise<void> | void;
}

function isAbort(err: unknown): boolean {
  return (
    err instanceof DOMException && err.name === 'AbortError'
  ) || (err instanceof Error && err.name === 'AbortError');
}

/**
 * Run the agent to completion (or abort). Returns the finalized assistant
 * message to persist. Throws on fatal non-abort errors (caller surfaces them).
 */
export async function runAgent(opts: RunAgentOpts): Promise<ChatMessage> {
  const messages: ChatTurn[] = [
    ...opts.history,
    {role: 'user', content: buildInitialUserMessage(opts)},
  ];
  const steps: AgentStep[] = [];
  let stepCounter = 0;
  // System prompt is built once — memories are fixed for the run.
  const systemPrompt = buildSystemPrompt({
    memoryEnabled: opts.memoryEnabled,
    memories: opts.memories,
  });

  let lastProse = '';
  let lastThinking = '';
  let lastAction: AssistantAction | null = null;
  // Current-turn partials, hoisted so an abort mid-stream can still finalize
  // whatever was streamed (rather than the previous turn's content).
  let curRaw = '';
  let curNativeThink = '';
  // Read de-duplication. Within one run the document is STATIC — only a terminal
  // patch mutates it, and a patch ends the loop — so a repeat read/search returns
  // the SAME text that's already earlier in `messages`. Re-injecting up to
  // READ_CHAR_CAP each time (the full doc is often already in the initial message)
  // can blow the model's context window across MAX_TURNS. Track what's been
  // injected and, on a repeat, return a short back-reference instead of the bytes.
  // `fullDocInjected` starts true in document mode (buildInitialUserMessage embeds
  // the whole doc); false in selection mode (only the selection is sent).
  let fullDocInjected = opts.mode === 'document';
  const queryCache = new Map<string, {hits: number}>();

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      let text = '';
      let nativeThink = '';
      curRaw = '';
      curNativeThink = '';
      // Reset the live action each turn so a stale partial card from a prior
      // turn doesn't linger.
      opts.onUpdate({action: null, text: '', thinking: ''});

      await streamChat(
        {system: systemPrompt, messages},
        {
          signal: opts.signal,
          onThinking: d => {
            nativeThink += d;
            curNativeThink = nativeThink;
            opts.onUpdate({thinking: nativeThink || extractThinking(text)});
          },
          onText: d => {
            text += d;
            curRaw = text;
            opts.onUpdate({
              text: stripMarkup(text),
              thinking: nativeThink || extractThinking(text),
              action: extractPartialAction(text) ?? undefined,
              steps: [...steps],
            });
          },
        },
      );

      const parsed = parseTurn(text);
      lastProse = parsed.prose;
      lastThinking = nativeThink || parsed.thinking;
      lastAction = parsed.action;

      // Non-terminal: remember → persist a long-term note, then loop.
      const remember =
        opts.memoryEnabled && opts.onRemember ? extractRememberAction(text) : null;
      if (remember && lastAction === null) {
        // A failed save (transient backend error) must NOT abort the whole turn —
        // the user would lose everything already streamed. Isolate it and tell the
        // model the note wasn't stored so it doesn't act as though it persisted.
        let saved = true;
        try {
          await opts.onRemember(remember.note);
        } catch {
          saved = false;
        }
        steps.push({kind: 'remember', note: remember.note, at: stepCounter++});
        opts.onUpdate({steps: [...steps]});

        messages.push({role: 'assistant', content: text});
        messages.push({
          role: 'user',
          content: saved
            ? `<result>\nSaved to long-term memory: "${remember.note}"\n</result>`
            : `<result>\nCould not save to long-term memory (a storage error occurred). Continue without it.\n</result>`,
        });
        continue;
      }

      // Non-terminal: read/search → execute against the doc and loop.
      const tool = extractToolAction(text);
      if (tool && lastAction === null) {
        const view = readDoc(opts.editor);
        const result = frameRead(view, tool.query);
        // A read/search with no effective query returns the whole doc; treat it
        // as a full read for de-duplication. The doc is static this run, so a
        // repeat yields identical bytes — swap in a back-reference instead of
        // re-injecting them (keeps context bounded across turns).
        const effectiveQuery = (tool.query ?? '').trim();
        const isFullRead = !effectiveQuery;
        const qKey = effectiveQuery.toLowerCase();
        let resultText: string;
        if (isFullRead && fullDocInjected) {
          resultText =
            '(The full document is already in this conversation and has not changed since — refer to the earlier copy above rather than re-reading it.)';
        } else if (!isFullRead && qKey && queryCache.has(qKey)) {
          const cached = queryCache.get(qKey)!.hits;
          resultText = `(Same ${cached} match${
            cached === 1 ? '' : 'es'
          } as your earlier ${tool.kind} for "${tool.query ?? ''}" — the document is unchanged; refer to that earlier result above.)`;
        } else {
          resultText = result.text;
          if (isFullRead) {
            fullDocInjected = true;
          } else if (qKey) {
            queryCache.set(qKey, {hits: result.hits});
          }
        }
        steps.push({
          kind: tool.kind,
          query: tool.query,
          hits: result.hits,
          at: stepCounter++,
        });
        opts.onUpdate({steps: [...steps]});

        messages.push({role: 'assistant', content: text});
        messages.push({
          role: 'user',
          content: `<result query=${JSON.stringify(tool.query ?? '')}>\n${resultText}\n</result>`,
        });
        continue;
      }

      // Terminal (patch / ask / finish) or pure-prose advice → done.
      return finalize(opts, steps, lastProse, lastThinking, lastAction, text);
    }
    // Cap reached: stop gracefully.
    return finalize(
      opts,
      steps,
      lastProse || '(stopped after reaching the step limit)',
      lastThinking,
      lastAction,
      '',
    );
  } catch (err) {
    // Preserve whatever streamed before the stop/throw: prefer the current turn's
    // partial (prose/thinking/even a completed action) over the prior turn's.
    const prose = stripMarkup(curRaw);
    const thinking = curNativeThink || extractThinking(curRaw);
    const action = extractPartialAction(curRaw);
    if (isAbort(err)) {
      return finalize(
        opts,
        steps,
        prose || lastProse || '(stopped)',
        thinking || lastThinking,
        action ?? lastAction,
        curRaw,
      );
    }
    // Non-abort error (backend `error` SSE event, network drop, or a helper throw
    // that escaped its own guard): keep what already streamed and attach the error
    // so the user doesn't lose the partial answer. MessageBubble renders the prose
    // bubble even when an error is attached; if nothing streamed, a clean error
    // bubble shows instead. (Resolving rather than re-throwing is deliberate — the
    // abort branch above already proved partials are worth preserving.)
    const msg = finalize(
      opts,
      steps,
      prose || lastProse,
      thinking || lastThinking,
      action ?? lastAction,
      curRaw,
    );
    msg.error = err instanceof Error ? err.message : String(err);
    return msg;
  }
}

function finalize(
  opts: RunAgentOpts,
  steps: AgentStep[],
  prose: string,
  thinking: string,
  action: AssistantAction | null,
  rawText: string,
): ChatMessage {
  const msg: ChatMessage = {
    id: '',
    role: 'assistant',
    text: prose,
    mode: opts.mode,
    thinking: thinking || undefined,
    steps: steps.length > 0 ? steps : undefined,
    action,
    streaming: false,
  };
  if (action?.kind === 'patch') {
    // Attach the patch's edits to the message (with per-edit state) so the
    // existing accept/reject + edit-state persistence keeps working. Edits are
    // parsed from the terminal turn's raw text (the action JSON lives there).
    const rawEdits = actionEdits(rawText);
    const edits = rawEdits
      .map(e => ({...e, state: 'pending' as ChatEditState}))
      // Drop no-op edits (replace === search) so we never offer unchanged text.
      .filter(e => e.replace.trim() !== e.search.trim());
    if (edits.length === 0) {
      // No real edits → downgrade to an advice turn (no empty patch card).
      msg.action = null;
      if (!msg.text.trim()) {
        msg.text = 'No changes to apply.';
      }
    } else {
      msg.edits = edits;
    }
  }
  return msg;
}

// --- initial user message --------------------------------------------------
function buildInitialUserMessage(opts: RunAgentOpts): string {
  if (opts.mode === 'selection' && opts.selectionText) {
    return [
      'The user selected this passage as the edit target:',
      '"""',
      opts.selectionText,
      '"""',
      '',
      `User request: ${opts.instruction}`,
      '',
      'Edit the selection directly with a patch, or use read/search first if you need wider context from the full document.',
    ].join('\n');
  }
  const {full} = readDoc(opts.editor);
  return [
    'Here is the current document:',
    '"""',
    full,
    '"""',
    '',
    `User request: ${opts.instruction}`,
  ].join('\n');
}
