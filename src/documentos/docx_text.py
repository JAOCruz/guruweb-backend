#!/usr/bin/env python3
"""
Documentos · Word engine (separate from MotherBrain's generator).

  list <path>             → JSON [{"i": n, "text": "..."}]  every paragraph (body + tables), in order
  hastags <path>          → "1" if the document has {{TAGS}}, else "0"
  apply <path> <out>      ← JSON ops on stdin: [{"op": "replace"|"insert_after"|"delete", "i": n, "text": "..."}]
  fill <path> <out>       ← JSON {"TAG": "value"} on stdin: exact {{TAG}} filling (tags without a value stay)
  spans <path> <out>      ← JSON [{"i": n, "start": a, "end": b, "text": "..."}]: replace character spans
  tags <path>             → JSON ["TAG", ...] every {{TAG}} in order (repeats included)

Edits keep each paragraph's style: the new text goes into the first run (its font/bold/size),
inserted paragraphs copy the style of the paragraph they follow. Spans and tag filling work inside
the runs, so the rest of the paragraph keeps its own bold/italics and each value its run's format.
"""
import copy
import json
import re
import sys

from docx import Document

TAG = re.compile(r"\{\{([^}]+)\}\}")


def paragraphs(doc):
    seen, out = set(), []
    def add(p):
        if id(p._p) not in seen:  # merged table cells repeat the same paragraph
            seen.add(id(p._p))
            out.append(p)
    for p in doc.paragraphs:
        add(p)
    for t in doc.tables:
        for row in t.rows:
            for cell in row.cells:
                for p in cell.paragraphs:
                    add(p)
    return out


def set_text(p, text):
    if p.runs:
        p.runs[0].text = text
        for r in p.runs[1:]:
            r.text = ""
    else:
        p.add_run(text)


def text_of(p):
    return "".join(r.text for r in p.runs)


def replace_spans(p, spans):
    """spans: [(start, end, text)] over text_of(p). Overlapping or out-of-range spans are skipped."""
    length = len(text_of(p))
    ok = []
    for start, end, text in spans:  # first come first served
        if 0 <= start < end <= length and all(end <= s or start >= e for s, e, _ in ok):
            ok.append((start, end, text))
    for start, end, text in sorted(ok, reverse=True):  # from the end, so earlier offsets stay valid
        pos, first = 0, True
        for r in p.runs:
            t = r.text
            rs, re_ = pos, pos + len(t)
            pos = re_
            if re_ <= start or rs >= end:
                continue
            a, b = max(start, rs) - rs, min(end, re_) - rs
            r.text = t[:a] + (text if first else "") + t[b:]
            first = False


def cmd_list(path):
    doc = Document(path)
    print(json.dumps([{"i": i, "text": text_of(p)} for i, p in enumerate(paragraphs(doc))], ensure_ascii=False))


def cmd_tags(path):
    doc = Document(path)
    print(json.dumps([m.group(1).strip() for p in paragraphs(doc) for m in TAG.finditer(text_of(p))], ensure_ascii=False))


def cmd_spans(path, out, items):
    doc = Document(path)
    ps = paragraphs(doc)
    by_p = {}
    for it in items:
        i = int(it.get("i", -1))
        if 0 <= i < len(ps):
            by_p.setdefault(i, []).append((int(it["start"]), int(it["end"]), str(it.get("text", ""))))
    for i, spans in by_p.items():
        replace_spans(ps[i], spans)
    doc.save(out)
    print(out)


def cmd_hastags(path):
    doc = Document(path)
    print("1" if any(TAG.search(p.text) for p in paragraphs(doc)) else "0")


def cmd_apply(path, out, ops):
    doc = Document(path)
    ps = paragraphs(doc)
    # inserts after the same paragraph keep their order: add them in reverse
    for op in reversed([o for o in ops if o.get("op") == "insert_after"]):
        i = int(op["i"])
        if 0 <= i < len(ps):
            new = copy.deepcopy(ps[i]._p)
            ps[i]._p.addnext(new)
            from docx.text.paragraph import Paragraph
            set_text(Paragraph(new, ps[i]._parent), str(op.get("text", "")))
    for op in ops:
        i = int(op.get("i", -1))
        if not 0 <= i < len(ps):
            continue
        if op.get("op") == "replace":
            set_text(ps[i], str(op.get("text", "")))
        elif op.get("op") == "delete":
            el = ps[i]._p
            el.getparent().remove(el)
    doc.save(out)
    print(out)


def cmd_fill(path, out, values):
    doc = Document(path)
    for p in paragraphs(doc):
        spans = [(m.start(), m.end(), str(values[m.group(1).strip()]))
                 for m in TAG.finditer(text_of(p)) if m.group(1).strip() in values]
        if spans:
            replace_spans(p, spans)
    doc.save(out)
    print(out)


if __name__ == "__main__":
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == "list":
        cmd_list(args[0])
    elif cmd == "hastags":
        cmd_hastags(args[0])
    elif cmd == "apply":
        cmd_apply(args[0], args[1], json.load(sys.stdin))
    elif cmd == "tags":
        cmd_tags(args[0])
    elif cmd == "spans":
        cmd_spans(args[0], args[1], json.load(sys.stdin))
    elif cmd == "fill":
        cmd_fill(args[0], args[1], json.load(sys.stdin))
    else:
        sys.exit(f"unknown command {cmd}")
