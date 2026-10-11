"""Runbook retrieval. Keyword/full-text search done by the backend (PostgreSQL); this module turns hits into
clearly-labelled guidance. Retrieved text is untrusted: it is cleaned, scanned for instruction-like content, and is
never mixed with evidence about the subject under investigation."""

from __future__ import annotations

import re

from .backend_client import BackendError, BackendReader
from .models import RunbookReference
from .untrusted import clean_untrusted

_MARKS = re.compile(r"[«»]")


def search_runbooks(
    reader: BackendReader, query: str, limit: int = 3, doc_type: str | None = None
) -> tuple[list[RunbookReference], list[str]]:
    if not query.strip():
        return [], []
    try:
        hits = reader.get("/api/v1/runbooks/search", {"q": query, "limit": limit, "type": doc_type})
    except BackendError as e:
        return [], [f"Runbook search unavailable ({e.kind})."]
    refs: list[RunbookReference] = []
    for h in hits or []:
        cleaned = clean_untrusted(_MARKS.sub("", h.get("snippet", "")), 400)
        refs.append(
            RunbookReference(
                source=f"runbook:{h['docKey']}@v{h['version']}",
                title=str(h.get("title", ""))[:200],
                docType=h.get("docType", "RUNBOOK"),
                snippet=cleaned.text,
                withheld=cleaned.withheld,
            )
        )
    return refs, []


def excerpts_for_prompt(refs: list[RunbookReference]) -> list[dict]:
    return [{"source": r.source, "title": r.title, "excerpt": r.snippet} for r in refs if not r.withheld]
