/**
 * gitEssay — registered node set.
 *
 * Forked from lexical-playground/src/nodes/PlaygroundNodes.ts; trimmed to the
 * academic-essential nodes (rich text, lists, tables, code, links, images,
 * equations, collapsible, page-break). Stripped: Poll/Tweet/YouTube/Figma/
 * Excalidraw/Sticky/Emoji/Mention/Keyword/DateTime/Layout/SpecialText/
 * Card/Slot/Review/PullQuote/Mark/Hashtag.
 */
import type {Klass, LexicalNode} from 'lexical';

import {CodeHighlightNode, CodeNode} from '@lexical/code';
import {HorizontalRuleNode} from '@lexical/extension';
import {AutoLinkNode, LinkNode} from '@lexical/link';
import {ListItemNode, ListNode} from '@lexical/list';
import {OverflowNode} from '@lexical/overflow';
import {HeadingNode, QuoteNode} from '@lexical/rich-text';
import {TableCellNode, TableNode, TableRowNode} from '@lexical/table';

import {CollapsibleContainerNode} from '../plugins/CollapsibleExtension/CollapsibleContainerNode';
import {CollapsibleContentNode} from '../plugins/CollapsibleExtension/CollapsibleContentNode';
import {CollapsibleTitleNode} from '../plugins/CollapsibleExtension/CollapsibleTitleNode';
import {EquationNode} from './EquationNode';
import {ImageNode} from './ImageNode';
import {PageBreakNode} from './PageBreakNode';

const PlaygroundNodes: Klass<LexicalNode>[] = [
  HeadingNode,
  ListNode,
  ListItemNode,
  QuoteNode,
  CodeNode,
  TableNode,
  TableCellNode,
  TableRowNode,
  CodeHighlightNode,
  AutoLinkNode,
  LinkNode,
  OverflowNode,
  ImageNode,
  EquationNode,
  HorizontalRuleNode,
  CollapsibleContainerNode,
  CollapsibleContentNode,
  CollapsibleTitleNode,
  PageBreakNode,
];

export default PlaygroundNodes;
