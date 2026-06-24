/**
 * gitEssay — shared rewrite-action descriptor.
 *
 * The action list (Tighten / Clarify / Formalize / Proofread / Expand) is shared
 * between the chat sidebar's quick-action chips and the mock provider's keyword
 * detection, so the two stay in sync.
 */
export interface RewriteAction {
  id: string;
  label: string;
  /** Short tooltip / hint. */
  hint: string;
}
