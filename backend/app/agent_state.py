"""gitEssay backend — LangGraph agent state.

The graph is built and run statelessly per request (no checkpointer in Phase 1 —
no HITL interrupts), so this state lives only for the duration of one agent run.
`doc_paragraphs` is the live sentinel-text snapshot the frontend sends (the
backend has no live editor). `read_hits` carries the read/search de-duplication
map (last-write-wins: the tools node returns the full updated dict each step).
"""
import operator
from typing import Annotated, Optional, TypedDict

from langchain.messages import AnyMessage
from langgraph.graph.message import add_messages


class AgentState(TypedDict):
    messages: Annotated[list[AnyMessage], add_messages]
    doc_paragraphs: list[str]
    steps: Annotated[list[dict], operator.add]
    terminal: Optional[dict]  # {'kind':'patch','explanation','edits'} | {'kind':'ask','question','options'}
    read_hits: dict  # {normalized_query_or_'': hits} — de-dup cache
