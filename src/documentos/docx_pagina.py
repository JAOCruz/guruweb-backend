#!/usr/bin/env python3
"""Precio por foja: tamaño de página y páginas de un Word, solo con la librería estándar.

  docx_pagina.py <path> → JSON {"h": twips, "pages": n|null, "words": n}
    h:     alto de la página de la primera sección (w:pgSz)
    pages: páginas que guardó Word (docProps/app.xml <Pages>), o null
    words: palabras del cuerpo
"""
import json
import re
import sys
import zipfile


def main(path):
    with zipfile.ZipFile(path) as z:
        doc = z.read("word/document.xml").decode("utf8", "ignore")
        app = z.read("docProps/app.xml").decode("utf8", "ignore") if "docProps/app.xml" in z.namelist() else ""
    sz = re.search(r"<w:pgSz\b[^>]*>", doc)
    h = re.search(r'w:h="(\d+)"', sz.group(0)) if sz else None
    pages = re.search(r"<Pages>(\d+)</Pages>", app)
    words = len(re.sub(r"<[^>]+>", " ", doc).split())
    print(json.dumps({"h": int(h.group(1)) if h else 0, "pages": int(pages.group(1)) if pages else None, "words": words}))


if __name__ == "__main__":
    main(sys.argv[1])
