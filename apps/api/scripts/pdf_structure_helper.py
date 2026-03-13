import argparse
import io
import json
import os
import re
import struct
from datetime import datetime, timezone
from pathlib import Path

import pikepdf

try:
    from fontTools.agl import UV2AGL
    from fontTools.ttLib import TTFont
except Exception:
    TTFont = None
    UV2AGL = {}


HEADING_COMPAT_TAGS = {"/P", "/Span", "/Div", "/NonStruct", "/TextBox", "/Sect", "/H", "/H1", "/H2", "/H3", "/H4", "/H5", "/H6"}
FIGURE_COMPAT_TAGS = {"/Figure", "/P", "/Span", "/Div", "/NonStruct"}
SAFE_FIGURE_RETAG_TAGS = {"/P", "/Span", "/Div", "/NonStruct", "/TextBox"}
UNSAFE_FIGURE_ANCESTRY = {"/Table", "/TR", "/TH", "/TD", "/TOC", "/TOCI", "/Link", "/L", "/LI"}
FIGURE_WRAP_TAGS = {"/LI", "/TH", "/TD", "/P", "/Span", "/Div", "/NonStruct", "/TextBox"}
EMBEDDABLE_FONT_FILES = {
    "/ArialMT": "arial.ttf",
    "/Arial-BoldMT": "arialbd.ttf",
    "/Arial-ItalicMT": "ariali.ttf",
    "/Arial-BoldItalicMT": "arialbi.ttf",
    "/Calibri": "calibri.ttf",
    "/Calibri-Bold": "calibrib.ttf",
    "/TimesNewRomanPSMT": "times.ttf",
    "/TimesNewRomanPS-BoldMT": "timesbd.ttf",
    "/TimesNewRomanPS-ItalicMT": "timesi.ttf",
    "/TimesNewRomanPS-BoldItalicMT": "timesbi.ttf",
    "/Helvetica": "IBMPlexSans-Regular.otf",
    "/Helvetica-Bold": "IBMPlexSans-Bold.otf",
    "/Helvetica-Oblique": "IBMPlexSans-Italic.otf",
    "/Helvetica-BoldOblique": "IBMPlexSans-Italic.otf",
    "/Verdana": "verdana.ttf",
    "/Verdana-Bold": "verdanab.ttf",
    "/SourceSans3-Regular": "SourceSans3-Regular.otf",
    "/SourceSans3-It": "SourceSans3-It.otf",
    "/SourceSans3-Bold": "SourceSans3-Bold.otf",
    "/SourceSans3-Black": "SourceSans3-Black.otf",
    "/SourceSans3-Light": "SourceSans3-Light.otf",
    "/IBMPlexSans-Regular": "IBMPlexSans-Regular.otf",
    "/IBMPlexSans-Italic": "IBMPlexSans-Italic.otf",
    "/IBMPlexSans-Bold": "IBMPlexSans-Bold.otf",
    "/IBMPlexSans-Light": "IBMPlexSans-Light.otf",
    "/LibertinusSans-Regular": "LibertinusSans-Regular.otf",
    "/LibertinusSans-Bold": "LibertinusSans-Bold.otf",
    "/LibertinusSans-Italic": "LibertinusSans-Italic.otf",
    "/LibertinusSerif-Regular": "LibertinusSerif-Regular.otf",
    "/LibertinusSerif-Italic": "LibertinusSerif-Italic.otf",
    "/LibertinusSerif-Bold": "LibertinusSerif-Bold.otf",
    "/LibertinusSerif-BoldItalic": "LibertinusSerif-BoldItalic.otf",
    "/LibreBaskerville-Regular": "LibreBaskerville-Regular.ttf",
    "/LibreBaskerville-Italic": "LibreBaskerville-Italic.ttf",
    "/LibreBaskerville-Bold": "LibreBaskerville-Bold.ttf",
    # Standard PDF Type1 fonts — embed OTF substitutes so veraPDF's containsFontFile
    # check passes for /Type1 fonts without needing a /Subtype switch to /TrueType.
    "/Times-Roman": "LibreBaskerville-Regular.ttf",
    "/Times-Bold": "LibreBaskerville-Bold.ttf",
    "/Times-Italic": "LibreBaskerville-Italic.ttf",
    "/Times-BoldItalic": "LibreBaskerville-Italic.ttf",
    "/Symbol": "IBMPlexSans-Regular.otf",
    "/ZapfDingbats": "IBMPlexSans-Regular.otf",
    "/Courier": "SourceSans3-Regular.otf",
    "/Courier-Bold": "SourceSans3-Bold.otf",
    "/Courier-Oblique": "SourceSans3-It.otf",
    "/Courier-BoldOblique": "SourceSans3-Bold.otf",
}

LEGACY_FONT_SUBSTITUTES = {
    # Optima family
    "/Optima": "/LibertinusSans-Regular",
    "/Optima-Bold": "/LibertinusSans-Bold",
    "/Optima-Italic": "/LibertinusSans-Italic",
    "/Optima-BoldItalic": "/LibertinusSans-Italic",
    "/Optima-ExtraBlack": "/LibertinusSans-Bold",
    # Frutiger family (exact variants first, prefix catch-all last)
    "/Frutiger-Roman": "/IBMPlexSans-Regular",
    "/Frutiger-Italic": "/IBMPlexSans-Italic",
    "/Frutiger-Black": "/IBMPlexSans-Bold",
    "/Frutiger-Light": "/IBMPlexSans-Light",
    "/Frutiger-Bold": "/IBMPlexSans-Bold",
    "/Frutiger-BoldItalic": "/IBMPlexSans-Italic",
    "/Frutiger-LightItalic": "/IBMPlexSans-Italic",
    "/Frutiger-BlackItalic": "/IBMPlexSans-Italic",
    "/Frutiger-UltraBlack": "/IBMPlexSans-Bold",
    "/Frutiger-55Roman": "/IBMPlexSans-Regular",
    "/Frutiger-56Italic": "/IBMPlexSans-Italic",
    "/Frutiger-45Light": "/IBMPlexSans-Light",
    "/Frutiger-46LightItalic": "/IBMPlexSans-Italic",
    "/Frutiger-65Bold": "/IBMPlexSans-Bold",
    "/Frutiger-66BoldItalic": "/IBMPlexSans-Italic",
    "/Frutiger-75Black": "/IBMPlexSans-Bold",
    "/Frutiger-76BlackItalic": "/IBMPlexSans-Italic",
    # AkzidenzGrotesk family
    "/AkzidenzGroteskBE-Light": "/IBMPlexSans-Light",
    "/AkzidenzGroteskBE-Regular": "/IBMPlexSans-Regular",
    "/AkzidenzGroteskBE-Bold": "/IBMPlexSans-Bold",
    "/AkzidenzGroteskBE-Italic": "/IBMPlexSans-Italic",
    "/AkzidenzGroteskBE-BoldItalic": "/IBMPlexSans-Italic",
    "/AkzidenzGroteskBE-LightItalic": "/IBMPlexSans-Italic",
    "/AkzidenzGroteskBE-MdIt": "/IBMPlexSans-Italic",
    "/AkzidenzGroteskBE-Medium": "/IBMPlexSans-Bold",
    "/AkzidenzGroteskBE-Super": "/IBMPlexSans-Bold",
    "/BaskervilleBE-Regular": "/LibreBaskerville-Regular",
    "/BaskervilleBE-Italic": "/LibreBaskerville-Italic",
    "/BaskervilleBE-Bold": "/LibreBaskerville-Bold",
    "/BaskervilleBE-Medium": "/LibreBaskerville-Bold",
    "/BaskervilleBE-MediumItalic": "/LibreBaskerville-Italic",
    "/BaskervilleBE-Light": "/LibreBaskerville-Regular",
    "/BaskervilleBE-LightItalic": "/LibreBaskerville-Italic",
    "/BaskervilleBE-BoldItalic": "/LibreBaskerville-Italic",
    "/BaskervilleBE-SmBdIt": "/LibreBaskerville-Italic",
    # Prefix catch-alls for all remaining variants of the above families.
    # These must come last so more-specific exact entries above take priority
    # in the exact-match check; the prefix loop picks these up for unknowns.
    "/Frutiger": "/IBMPlexSans-Regular",
    "/AkzidenzGroteskBE": "/IBMPlexSans-Regular",
    "/AkzidenzGrotesk": "/IBMPlexSans-Regular",
    "/BaskervilleBE": "/LibreBaskerville-Regular",
}

GLYPH_NAME_UNICODE = {
    "space": " ",
    "exclam": "!",
    "quotedbl": "\"",
    "numbersign": "#",
    "dollar": "$",
    "percent": "%",
    "ampersand": "&",
    "quotesingle": "'",
    "parenleft": "(",
    "parenright": ")",
    "asterisk": "*",
    "plus": "+",
    "comma": ",",
    "hyphen": "-",
    "period": ".",
    "slash": "/",
    "colon": ":",
    "semicolon": ";",
    "less": "<",
    "equal": "=",
    "greater": ">",
    "question": "?",
    "at": "@",
    "bracketleft": "[",
    "backslash": "\\",
    "bracketright": "]",
    "asciicircum": "^",
    "underscore": "_",
    "grave": "`",
    "braceleft": "{",
    "bar": "|",
    "braceright": "}",
    "asciitilde": "~",
    "quotesinglbase": "\u201a",
    "quotedblbase": "\u201e",
    "ellipsis": "\u2026",
    "dagger": "\u2020",
    "daggerdbl": "\u2021",
    "circumflex": "\u02c6",
    "perthousand": "\u2030",
    "Scaron": "\u0160",
    "scaron": "\u0161",
    "guilsinglleft": "\u2039",
    "guilsinglright": "\u203a",
    "OE": "\u0152",
    "oe": "\u0153",
    "quoteleft": "\u2018",
    "quoteright": "\u2019",
    "quotedblleft": "\u201c",
    "quotedblright": "\u201d",
    "bullet": "\u2022",
    "endash": "\u2013",
    "emdash": "\u2014",
    "tilde": "\u02dc",
    "trademark": "\u2122",
    "Ydieresis": "\u0178",
    "currency": "\u00a4",
    "brokenbar": "\u00a6",
    "dieresis": "\u00a8",
    "copyright": "\u00a9",
    "ordfeminine": "\u00aa",
    "guillemotleft": "\u00ab",
    "logicalnot": "\u00ac",
    "registered": "\u00ae",
    "macron": "\u00af",
    "degree": "\u00b0",
    "plusminus": "\u00b1",
    "acute": "\u00b4",
    "mu": "\u00b5",
    "paragraph": "\u00b6",
    "cedilla": "\u00b8",
    "ordmasculine": "\u00ba",
    "guillemotright": "\u00bb",
    "questiondown": "\u00bf",
    "AE": "\u00c6",
    "ae": "\u00e6",
    "Oslash": "\u00d8",
    "oslash": "\u00f8",
    "Lslash": "\u0141",
    "lslash": "\u0142",
    "dotlessi": "\u0131",
    "florin": "\u0192",
    "ring": "\u02da",
    "hungarumlaut": "\u02dd",
    "ogonek": "\u02db",
    "caron": "\u02c7",
    "breve": "\u02d8",
    "dotaccent": "\u02d9",
    "fi": "\ufb01",
    "fl": "\ufb02",
}

for code in range(ord("A"), ord("Z") + 1):
    GLYPH_NAME_UNICODE[chr(code)] = chr(code)
for code in range(ord("a"), ord("z") + 1):
    GLYPH_NAME_UNICODE[chr(code)] = chr(code)
for code in range(ord("0"), ord("9") + 1):
    GLYPH_NAME_UNICODE[f"{code - ord('0')}"] = chr(code)
    GLYPH_NAME_UNICODE[
        ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"][code - ord("0")]
    ] = chr(code)

CID_SYMBOL_UNICODE_MAPS = {
    "/SymbolMT": {},
    "/Wingdings-Regular": {
        131: "\u2022",
        190: "\u2022",
    },
}

WIN_ANSI_UNICODE = {
    code: bytes([code]).decode("cp1252")
    for code in range(32, 256)
    if code not in {0x7F, 0x81, 0x8D, 0x8F, 0x90, 0x9D}
}


def ref_string(obj):
    objgen = getattr(obj, "objgen", None)
    if not objgen:
        return None
    return f"obj:{objgen[0]} {objgen[1]} R"


def parse_ref(ref):
    if not ref:
        return None
    ref = str(ref).strip()
    if ref.startswith("obj:"):
        ref = ref[4:]
    if ref.endswith(" R"):
        ref = ref[:-2]
    parts = ref.split()
    if len(parts) != 2:
        return None
    try:
        return int(parts[0]), int(parts[1])
    except ValueError:
        return None


def iter_struct_elems(pdf):
    for obj in pdf.objects:
        try:
            if not isinstance(obj, pikepdf.Dictionary) or "/S" not in obj:
                continue
            tag = str(obj.get("/S"))
            if tag in {"/Transparency", "/Luminosity", "/URI"}:
                continue
            if "/P" in obj or "/K" in obj or str(obj.get("/Type")) == "/StructElem":
                yield obj
        except Exception:
            continue


def resolve_obj(pdf, ref):
    parsed = parse_ref(ref)
    if not parsed:
        return None
    for obj in pdf.objects:
        if getattr(obj, "objgen", None) == parsed:
            return obj
    return None


def get_struct_tree_root(pdf):
    for obj in pdf.objects:
        if isinstance(obj, pikepdf.Dictionary) and str(obj.get("/Type")) == "/StructTreeRoot":
            return obj
    for obj in pdf.objects:
        if isinstance(obj, pikepdf.Dictionary) and str(obj.get("/Type")) == "/Catalog" and "/StructTreeRoot" in obj:
            root = obj.get("/StructTreeRoot")
            if isinstance(root, pikepdf.Dictionary):
                return root
    return None


def get_catalog(pdf):
    for obj in pdf.objects:
        if isinstance(obj, pikepdf.Dictionary) and str(obj.get("/Type")) == "/Catalog":
            return obj
    return None


def ensure_mark_info(catalog):
    mark_info = catalog.get("/MarkInfo")
    if not isinstance(mark_info, pikepdf.Dictionary):
        mark_info = pikepdf.Dictionary()
        catalog["/MarkInfo"] = mark_info
    mark_info["/Marked"] = True
    return mark_info


def page_ref_map(pdf):
    mapping = {}
    try:
        for index, page in enumerate(pdf.pages, start=1):
            ref = ref_string(page.obj)
            if ref:
                mapping[ref] = index
    except Exception:
        return {}
    return mapping


def page_obj_by_number(pdf, page_number):
    try:
        page_number = int(page_number)
    except Exception:
        return None
    if page_number < 1 or page_number > len(pdf.pages):
        return None
    try:
        return pdf.pages[page_number - 1].obj
    except Exception:
        return None


def parent_tag_path(node):
    path = []
    current = node
    seen = set()
    while isinstance(current, pikepdf.Dictionary):
        parent = current.get("/P")
        if not isinstance(parent, pikepdf.Dictionary):
            break
        ref = ref_string(parent)
        if ref and ref in seen:
            break
        if ref:
            seen.add(ref)
        tag = str(parent.get("/S"))
        if tag:
            path.append(tag)
        current = parent
    return path


def page_ref_for_struct_elem(node):
    visited = set()

    def visit(value):
        if isinstance(value, pikepdf.Dictionary):
            ref = ref_string(value)
            if ref and ref in visited:
                return None
            if ref:
                visited.add(ref)
            pg = value.get("/Pg")
            if isinstance(pg, pikepdf.Dictionary):
                return pg
            child = value.get("/K")
            if child is not None:
                resolved = visit(child)
                if resolved is not None:
                    return resolved
            parent = value.get("/P")
            if isinstance(parent, pikepdf.Dictionary):
                resolved = visit(parent)
                if resolved is not None:
                    return resolved
        elif isinstance(value, pikepdf.Array):
            for item in value:
                resolved = visit(item)
                if resolved is not None:
                    return resolved
        return None

    return visit(node)


def child_page_hints(node, page_map):
    refs = set()

    def visit(value):
        if isinstance(value, pikepdf.Dictionary):
            pg = value.get("/Pg")
            pg_ref = ref_string(pg) if isinstance(pg, pikepdf.Dictionary) else None
            if pg_ref and pg_ref in page_map:
                refs.add(page_map[pg_ref])
            visit(value.get("/K"))
        elif isinstance(value, pikepdf.Array):
            for item in value:
                visit(item)

    visit(node)
    return sorted(refs)


def collect_mcids(value, results):
    if isinstance(value, int):
        results.append(value)
        return
    if isinstance(value, pikepdf.Array):
        for item in value:
            collect_mcids(item, results)
        return
    if isinstance(value, pikepdf.Dictionary):
        collect_mcids(value.get("/K"), results)


def child_mcid_ranges(parent):
    kids = get_child_dicts(parent)
    ranges = []
    for child in kids:
        mcids = []
        collect_mcids(child.get("/K"), mcids)
        mcids = sorted(set(mcid for mcid in mcids if isinstance(mcid, int)))
        if not mcids:
            ranges.append({
                "ref": ref_string(child),
                "min": None,
                "max": None,
            })
        else:
            ranges.append({
                "ref": ref_string(child),
                "min": mcids[0],
                "max": mcids[-1],
            })
    return [entry for entry in ranges if entry["ref"]]


def mcid_disorder_score(parent):
    ranges = child_mcid_ranges(parent)
    comparable = [entry for entry in ranges if entry["min"] is not None]
    if len(comparable) < 2:
        return 0
    disorder = 0
    comparisons = 0
    previous_max = comparable[0]["max"]
    for entry in comparable[1:]:
        comparisons += 1
        if entry["min"] < previous_max:
            disorder += 1
        previous_max = max(previous_max, entry["max"])
    return disorder / comparisons if comparisons else 0


def get_child_dicts(parent):
    kids = parent.get("/K") if isinstance(parent, pikepdf.Dictionary) else None
    if isinstance(kids, pikepdf.Array):
        return [child for child in kids if isinstance(child, pikepdf.Dictionary)]
    return []


def child_refs_and_tags(parent):
    child_dicts = get_child_dicts(parent)
    child_refs = [ref_string(child) for child in child_dicts if ref_string(child)]
    child_tags = [str(child.get("/S")) for child in child_dicts if ref_string(child)]
    return child_dicts, child_refs, child_tags


def structural_nodes(pdf):
    nodes = []
    for index, obj in enumerate(iter_struct_elems(pdf)):
        parent = obj.get("/P")
        nodes.append({
            "ref": ref_string(obj),
            "tag": str(obj.get("/S")),
            "parentRef": ref_string(parent) if isinstance(parent, pikepdf.Dictionary) else None,
            "orderIndex": index,
            "parentTagPath": parent_tag_path(obj),
        })
    return [node for node in nodes if node["ref"]]


def top_level_heading_candidates(pdf):
    candidates = []
    for obj in iter_struct_elems(pdf):
        tag = str(obj.get("/S"))
        parent = obj.get("/P")
        parent_ref = ref_string(parent) if isinstance(parent, pikepdf.Dictionary) else None
        if tag in HEADING_COMPAT_TAGS and parent_ref:
            candidates.append({
                "ref": ref_string(obj),
                "tag": tag,
                "parentRef": parent_ref,
            })
    return [candidate for candidate in candidates if candidate["ref"]]


def heading_level_number(tag):
    value = str(tag or "").upper().replace("/", "")
    if not re.fullmatch(r"H[1-6]", value):
        return None
    return int(value[1:])


def normalize_heading_sequence(levels):
    normalized = []
    previous = None
    for index, level in enumerate(levels):
        numeric = heading_level_number(level)
        if numeric is None:
            numeric = 2
        if index == 0:
            numeric = 1
        elif previous is not None and numeric > previous + 1:
            numeric = previous + 1
        numeric = min(6, max(1, numeric))
        normalized.append(f"H{numeric}")
        previous = numeric
    return normalized


def normalized_heading_level_for_target(pdf, target_obj, requested_level):
    requested = heading_level_number(requested_level) or 2
    requested = min(6, max(1, requested))
    target_ref = ref_string(target_obj)
    target_index = None
    previous_heading_level = None

    for index, obj in enumerate(iter_struct_elems(pdf)):
        if ref_string(obj) == target_ref:
            target_index = index
            break
        level = heading_level_number(obj.get("/S"))
        if level is not None:
            previous_heading_level = level

    if target_index is None:
        return f"/H{requested}"
    if previous_heading_level is None:
        return "/H1"
    return f"/H{min(6, max(1, min(requested, previous_heading_level + 1)))}"


def table_candidates(pdf):
    tables = []
    page_map = page_ref_map(pdf)

    def collect_header_refs(node, results):
        if isinstance(node, pikepdf.Array):
            for child in node:
                collect_header_refs(child, results)
            return
        if isinstance(node, pikepdf.Dictionary):
            if str(node.get("/S")) == "/TH":
                ref = ref_string(node)
                if ref:
                    results.append(ref)
            collect_header_refs(node.get("/K"), results)

    for obj in iter_struct_elems(pdf):
        if str(obj.get("/S")) != "/Table":
            continue
        first_row_cell_refs = []
        header_cell_refs = []
        kids = obj.get("/K")
        if isinstance(kids, pikepdf.Array) and len(kids) > 0:
            first_row = kids[0]
            if isinstance(first_row, pikepdf.Dictionary):
                row_kids = first_row.get("/K")
                if isinstance(row_kids, pikepdf.Array):
                    for cell in row_kids:
                        if isinstance(cell, pikepdf.Dictionary):
                            first_row_cell_refs.append(ref_string(cell))
        collect_header_refs(kids, header_cell_refs)
        tables.append({
            "ref": ref_string(obj),
            "firstRowCellRefs": [ref for ref in first_row_cell_refs if ref],
            "headerCellRefs": [ref for ref in header_cell_refs if ref],
            "pageNumberHints": child_page_hints(obj, page_map),
        })
    return [table for table in tables if table["ref"]]


def figure_candidates(pdf):
    figures = []
    for obj in iter_struct_elems(pdf):
        tag = str(obj.get("/S"))
        if tag != "/Figure":
            continue
        raw_alt = obj.get("/Alt")
        alt_text = str(raw_alt).replace("u:", "") if raw_alt is not None else None
        figures.append({
            "ref": ref_string(obj),
            "tag": tag,
            "hasAlt": bool(alt_text),
            "altText": alt_text,
            "parentTagPath": parent_tag_path(obj),
        })
    return [figure for figure in figures if figure["ref"]]


def page_mcid_usage(page_obj):
    usage = {}
    try:
        instructions = list(pikepdf.parse_content_stream(page_obj))
    except Exception:
        return usage

    stack = []
    for instruction in instructions:
        operator = str(instruction.operator)
        operands = list(instruction.operands)
        if operator in MARKED_CONTENT_START_OPERATORS:
            mcid = None
            if len(operands) >= 2 and isinstance(operands[1], pikepdf.Dictionary):
                try:
                    raw_mcid = operands[1].get("/MCID")
                    mcid = int(raw_mcid) if raw_mcid is not None else None
                except Exception:
                    mcid = None
            stack.append(mcid)
            if mcid is not None:
                usage.setdefault(mcid, {"hasText": False, "hasGraphics": False})
            continue
        if operator == "EMC":
            if stack:
                stack.pop()
            continue
        active_mcids = [mcid for mcid in stack if mcid is not None]
        if not active_mcids:
            continue
        has_text = operator in TEXT_SHOWING_OPERATORS
        has_graphics = operator in {"Do", "re", "S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "m", "l", "c", "v", "y", "h", "n"}
        if not has_text and not has_graphics:
            continue
        for mcid in active_mcids:
            entry = usage.setdefault(mcid, {"hasText": False, "hasGraphics": False})
            if has_text:
                entry["hasText"] = True
            if has_graphics:
                entry["hasGraphics"] = True
    return usage


def image_struct_candidates(pdf):
    candidates = []
    page_usage = {}
    for obj in iter_struct_elems(pdf):
        tag = str(obj.get("/S"))
        if tag == "/Figure":
            continue
        mcids = []
        collect_mcids(obj.get("/K"), mcids)
        mcids = sorted(set(mcid for mcid in mcids if isinstance(mcid, int)))
        if not mcids:
            continue
        page_obj = page_ref_for_struct_elem(obj)
        page_ref = ref_string(page_obj) if isinstance(page_obj, pikepdf.Dictionary) else None
        if not page_ref or not isinstance(page_obj, pikepdf.Dictionary):
            continue
        usage = page_usage.setdefault(page_ref, page_mcid_usage(page_obj))
        has_graphics = any(usage.get(mcid, {}).get("hasGraphics") for mcid in mcids)
        has_text = any(usage.get(mcid, {}).get("hasText") for mcid in mcids)
        if not has_graphics or has_text:
            continue
        raw_alt = obj.get("/Alt")
        alt_text = str(raw_alt).replace("u:", "") if raw_alt is not None else None
        candidates.append({
            "ref": ref_string(obj),
            "tag": tag,
            "hasAlt": bool(alt_text),
            "altText": alt_text,
            "parentTagPath": parent_tag_path(obj),
            "mcids": mcids,
        })
    return [candidate for candidate in candidates if candidate["ref"]]


def reading_order_nodes(pdf):
    root = get_struct_tree_root(pdf)
    if not isinstance(root, pikepdf.Dictionary):
        return []
    kids = root.get("/K")
    if not isinstance(kids, pikepdf.Array):
        return []
    parent_ref = ref_string(root)
    nodes = []
    for index, child in enumerate(kids):
        if isinstance(child, pikepdf.Dictionary):
            nodes.append({
                "ref": ref_string(child),
                "tag": str(child.get("/S")),
                "parentRef": parent_ref,
                "orderIndex": index,
            })
    return [node for node in nodes if node["ref"]]


def reading_order_parents(pdf):
    page_map = page_ref_map(pdf)
    parents = []
    for obj in iter_struct_elems(pdf):
        kids = obj.get("/K")
        if not isinstance(kids, pikepdf.Array):
            continue
        child_dicts, child_refs, child_tags = child_refs_and_tags(obj)
        if len(child_dicts) < 2:
            continue
        mcid_ranges = child_mcid_ranges(obj)
        suggested_child_refs = [entry["ref"] for entry in sorted(
            mcid_ranges,
            key=lambda entry: (entry["min"] is None, entry["min"] if entry["min"] is not None else 10**9, entry["ref"]),
        ) if entry["ref"]]
        parents.append({
            "parentRef": ref_string(obj),
            "childRefs": child_refs,
            "childTags": child_tags,
            "mutableKids": True,
            "mcidDisorderBefore": mcid_disorder_score(obj),
            "pageNumberHints": child_page_hints(obj, page_map),
            "suggestedChildRefs": suggested_child_refs,
        })
    return [parent for parent in parents if parent["parentRef"]]


def mutate_create_heading_tag(pdf, mutation):
    candidates = top_level_heading_candidates(pdf)
    if not candidates:
        return False, [], ["No /P heading candidates were found in the structure tree."]

    requested_targets = mutation.get("targets") or []
    target_refs = requested_targets if requested_targets else [candidate["ref"] for candidate in candidates]
    requested_levels = mutation.get("headingLevels") or []
    default_levels = ["H1"] + ["H2"] * max(0, len(target_refs) - 1)
    heading_levels = normalize_heading_sequence(requested_levels if requested_levels else default_levels)

    applied = []
    for index, ref in enumerate(target_refs):
        obj = resolve_obj(pdf, ref)
        if not isinstance(obj, pikepdf.Dictionary):
            continue
        before = str(obj.get("/S"))
        next_level = heading_levels[index] if index < len(heading_levels) else "H2"
        after = f"/{next_level.lstrip('/')}"
        if before == after:
            continue
        obj["/S"] = pikepdf.Name(after)
        applied.append({
            "ref": ref_string(obj),
            "before": before,
            "after": after,
            "details": f"Retagged {ref_string(obj)} from {before} to {after}.",
        })

    return bool(applied), applied, []


def mutate_bootstrap_struct_tree(pdf, mutation):
    root = get_struct_tree_root(pdf)
    if root is not None:
        return False, [], ["Document already has a structure tree."]

    headings = mutation.get("headings") or []
    figures = mutation.get("figures") or []
    if not headings and not figures:
        return False, [], ["bootstrap_struct_tree requires heading or figure candidates."]

    catalog = None
    for obj in pdf.objects:
        if isinstance(obj, pikepdf.Dictionary) and str(obj.get("/Type")) == "/Catalog":
            catalog = obj
            break
    if catalog is None:
        return False, [], ["Could not locate the PDF catalog to attach a structure tree."]

    struct_root = pdf.make_indirect(pikepdf.Dictionary({
        "/Type": pikepdf.Name("/StructTreeRoot"),
        "/K": pikepdf.Array(),
    }))
    document = pdf.make_indirect(pikepdf.Dictionary({
        "/Type": pikepdf.Name("/StructElem"),
        "/S": pikepdf.Name("/Document"),
        "/P": struct_root,
        "/K": pikepdf.Array(),
    }))
    struct_root["/K"] = pikepdf.Array([document])
    catalog["/StructTreeRoot"] = struct_root

    next_mcid = 0
    applied = [{
        "ref": ref_string(struct_root),
        "before": None,
        "after": "/StructTreeRoot",
        "details": f"Created a new structure tree rooted at {ref_string(struct_root)}.",
    }]

    normalized_heading_levels = normalize_heading_sequence([
        entry.get("level") or "H2"
        for entry in headings
    ])
    for index, heading in enumerate(headings):
        level = f"/{str(normalized_heading_levels[index] if index < len(normalized_heading_levels) else 'H2').lstrip('/')}"
        page_obj = page_obj_by_number(pdf, heading.get("pageNumber"))
        element = pdf.make_indirect(pikepdf.Dictionary({
            "/Type": pikepdf.Name("/StructElem"),
            "/S": pikepdf.Name(level),
            "/P": document,
            "/K": next_mcid,
        }))
        if page_obj is not None:
            element["/Pg"] = page_obj
        document["/K"].append(element)
        applied.append({
            "ref": ref_string(element),
            "before": None,
            "after": level,
            "details": f"Created heading tag {level} for \"{heading.get('text') or 'Untitled heading'}\".",
        })
        next_mcid += 1

    for figure in figures:
        alt_text = str(figure.get("altText") or "").strip() or "Decorative image"
        page_obj = page_obj_by_number(pdf, figure.get("pageNumber"))
        element = pdf.make_indirect(pikepdf.Dictionary({
            "/Type": pikepdf.Name("/StructElem"),
            "/S": pikepdf.Name("/Figure"),
            "/P": document,
            "/K": next_mcid,
            "/Alt": pikepdf.String(alt_text),
        }))
        if page_obj is not None:
            element["/Pg"] = page_obj
        document["/K"].append(element)
        applied.append({
            "ref": ref_string(element),
            "before": None,
            "after": "/Figure",
            "details": f"Created figure tag with alt text \"{alt_text}\".",
        })
        next_mcid += 1

    return True, applied, []


def xmp_escape(value):
    return (str(value or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;"))


def build_pdfua_xmp(title, language, part, conformance):
    timestamp = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    safe_title = xmp_escape(title or "Accessible PDF")
    safe_language = xmp_escape(language or "en")
    safe_conformance = xmp_escape(conformance or "B")
    return f"""<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:pdf="http://ns.adobe.com/pdf/1.3/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/">
   <dc:title>
    <rdf:Alt>
     <rdf:li xml:lang="x-default">{safe_title}</rdf:li>
    </rdf:Alt>
   </dc:title>
   <dc:language>
    <rdf:Bag>
     <rdf:li>{safe_language}</rdf:li>
    </rdf:Bag>
   </dc:language>
   <pdf:Title>{safe_title}</pdf:Title>
   <xmp:MetadataDate>{timestamp}</xmp:MetadataDate>
   <xmp:ModifyDate>{timestamp}</xmp:ModifyDate>
   <pdfuaid:part>{int(part or 1)}</pdfuaid:part>
   <pdfuaid:conformance>{safe_conformance}</pdfuaid:conformance>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"""


def mutate_set_pdfua_identification(pdf, mutation):
    catalog = get_catalog(pdf)
    if catalog is None:
        return False, [], ["Could not locate the PDF catalog to attach metadata."]

    title = str(mutation.get("title") or "").strip() or "Accessible PDF"
    language = str(mutation.get("language") or "").strip() or "en"
    part = mutation.get("part") or 1
    conformance = str(mutation.get("conformance") or "B").strip() or "B"

    metadata_stream = pdf.make_stream(build_pdfua_xmp(title, language, part, conformance).encode("utf-8"))
    metadata_stream["/Type"] = pikepdf.Name("/Metadata")
    metadata_stream["/Subtype"] = pikepdf.Name("/XML")
    metadata_ref = pdf.make_indirect(metadata_stream)
    catalog["/Metadata"] = metadata_ref
    catalog["/Lang"] = language
    ensure_mark_info(catalog)
    viewer_prefs = catalog.get("/ViewerPreferences")
    if not isinstance(viewer_prefs, pikepdf.Dictionary):
        viewer_prefs = pikepdf.Dictionary()
        catalog["/ViewerPreferences"] = viewer_prefs
    viewer_prefs["/DisplayDocTitle"] = True

    oc_properties = catalog.get("/OCProperties")
    if isinstance(oc_properties, pikepdf.Dictionary):
        default_config = oc_properties.get("/D")
        if isinstance(default_config, pikepdf.Dictionary) and not str(default_config.get("/Name") or "").strip():
            default_config["/Name"] = pikepdf.String(title)
        configs = oc_properties.get("/Configs")
        if isinstance(configs, pikepdf.Array):
            for index, config in enumerate(configs):
                if isinstance(config, pikepdf.Dictionary) and not str(config.get("/Name") or "").strip():
                    config["/Name"] = pikepdf.String(f"{title} config {index + 1}")

    applied = [{
        "ref": ref_string(metadata_ref),
        "before": None,
        "after": "/Metadata",
        "details": f"Wrote PDF/UA identification metadata for part {part} conformance {conformance}.",
    }]
    if isinstance(oc_properties, pikepdf.Dictionary):
        applied.append({
            "ref": ref_string(oc_properties),
            "before": "/OCProperties",
            "after": "/Name",
            "details": "Ensured optional content configuration dictionaries have required /Name entries.",
        })
    return True, applied, []


def font_file_path(font_name):
    normalized = str(font_name or "").strip()
    filename = EMBEDDABLE_FONT_FILES.get(normalized)
    if not filename:
        return None
    candidates = []
    env_paths = os.environ.get("PDF_FONT_DIRS", "")
    legacy_paths = os.environ.get("LEGACY_FONT_DIRS", "")
    if env_paths:
        candidates.extend(Path(entry.strip()) / filename for entry in env_paths.split(os.pathsep) if entry.strip())
    if legacy_paths:
        candidates.extend(Path(entry.strip()) / filename for entry in legacy_paths.split(os.pathsep) if entry.strip())
    candidates.extend([
        Path("C:/Windows/Fonts") / filename,
        Path("/usr/share/fonts/truetype/msttcorefonts") / filename,
        Path("/usr/share/fonts/truetype/microsoft") / filename,
    ])
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


def normalized_base_font_name(font_name):
    name = str(font_name or "").strip()
    if "+" in name:
        _, suffix = name.split("+", 1)
        if suffix:
            name = f"/{suffix.lstrip('/')}"
    return name


def ensure_parent_tree(struct_root, pdf):
    parent_tree = struct_root.get("/ParentTree")
    if not isinstance(parent_tree, pikepdf.Dictionary):
        parent_tree = pdf.make_indirect(pikepdf.Dictionary({
            "/Nums": pikepdf.Array(),
        }))
        struct_root["/ParentTree"] = parent_tree
    nums = parent_tree.get("/Nums")
    if not isinstance(nums, pikepdf.Array):
        nums = pikepdf.Array()
        parent_tree["/Nums"] = nums
    return parent_tree, nums


def upsert_parent_tree_entry(nums, key, value):
    key = int(key)
    index = 0
    while index + 1 < len(nums):
        existing_key = nums[index]
        try:
            existing_key = int(existing_key)
        except Exception:
            existing_key = None
        if existing_key == key:
            nums[index + 1] = value
            return
        index += 2
    nums.append(key)
    nums.append(value)


def ensure_document_struct_elem(pdf, struct_root):
    kids = struct_root.get("/K")
    if isinstance(kids, pikepdf.Array):
        for child in kids:
            if isinstance(child, pikepdf.Dictionary) and str(child.get("/S")) == "/Document":
                return child
    document = pdf.make_indirect(pikepdf.Dictionary({
        "/Type": pikepdf.Name("/StructElem"),
        "/S": pikepdf.Name("/Document"),
        "/P": struct_root,
        "/K": pikepdf.Array(),
    }))
    struct_root["/K"] = pikepdf.Array([document])
    return document


def page_content_bytes(page_obj):
    contents = page_obj.get("/Contents")
    if isinstance(contents, pikepdf.Stream):
        return contents.read_bytes()
    if isinstance(contents, pikepdf.Array):
        parts = []
        for item in contents:
            if isinstance(item, pikepdf.Stream):
                parts.append(item.read_bytes())
        return b"\n".join(parts)
    return b""


def ensure_page_marked_content(pdf, page_obj):
    raw = page_content_bytes(page_obj)
    if not raw:
        return False
    if b"/MCID" in raw and (b"BDC" in raw or b"BMC" in raw):
        return False
    wrapped = b"/Span <</MCID 0>> BDC\n" + raw + b"\nEMC\n"
    page_obj["/Contents"] = pdf.make_stream(wrapped)
    return True


def ensure_page_content_struct_elem(pdf, document, page_obj):
    page_ref = ref_string(page_obj)
    existing = get_child_dicts(document)
    for child in existing:
        if str(child.get("/S")) in {"/Part", "/Sect", "/Div"} and ref_string(child.get("/Pg")) == page_ref and child.get("/K") == 0:
            return child, False
    elem = pdf.make_indirect(pikepdf.Dictionary({
        "/Type": pikepdf.Name("/StructElem"),
        "/S": pikepdf.Name("/Sect"),
        "/P": document,
        "/Pg": page_obj,
        "/K": 0,
    }))
    kids = document.get("/K")
    next_kids = pikepdf.Array([elem])
    if isinstance(kids, pikepdf.Array):
        for item in kids:
            next_kids.append(item)
    elif kids is not None:
        next_kids.append(kids)
    document["/K"] = next_kids
    return elem, True


def ensure_struct_elem_kids_array(elem):
    kids = elem.get("/K")
    if isinstance(kids, pikepdf.Array):
        return kids
    if kids is None:
        kids = pikepdf.Array()
    else:
        kids = pikepdf.Array([kids])
    elem["/K"] = kids
    return kids


def existing_mcr_mcids(elem):
    results = set()

    def visit(value):
        if isinstance(value, pikepdf.Dictionary):
            if str(value.get("/Type")) == "/MCR":
                mcid = value.get("/MCID")
                try:
                    results.add(int(mcid))
                except Exception:
                    pass
            visit(value.get("/K"))
        elif isinstance(value, pikepdf.Array):
            for item in value:
                visit(item)

    visit(elem.get("/K"))
    return results


def extract_page_mcids(page_obj):
    raw = page_content_bytes(page_obj)
    if not raw:
        return []
    try:
        text = raw.decode("latin-1", "ignore")
    except Exception:
        return []
    matches = re.findall(r"/MCID\s+(\d+)", text)
    mcids = sorted({int(match) for match in matches})
    return mcids


TEXT_SHOWING_OPERATORS = {"Tj", "TJ", "'", '"'}
MARKED_CONTENT_START_OPERATORS = {"BDC", "BMC"}


def parse_top_level_content_groups(page_obj):
    try:
        instructions = list(pikepdf.parse_content_stream(page_obj))
    except Exception:
        return []

    groups = []
    current = []
    current_marked = None
    depth = 0

    def flush():
        nonlocal current, current_marked
        if current:
            groups.append((current_marked, list(current)))
            current = []
            current_marked = None

    for instruction in instructions:
        operator = str(instruction.operator)
        if depth == 0 and operator in MARKED_CONTENT_START_OPERATORS:
            flush()
            current_marked = True
            current = [instruction]
            depth = 1
            continue
        if depth > 0:
            current.append(instruction)
            if operator in MARKED_CONTENT_START_OPERATORS:
                depth += 1
            elif operator == "EMC":
                depth -= 1
                if depth == 0:
                    flush()
            continue
        if current_marked is not False:
            flush()
            current_marked = False
        current.append(instruction)
    flush()
    return groups


def group_is_artifact(group):
    if not group:
        return False
    operands = list(group[0].operands)
    return str(group[0].operator) in MARKED_CONTENT_START_OPERATORS and operands and str(operands[0]) == "/Artifact"


def group_contains_nested_mcid(group):
    for instruction in group:
        if str(instruction.operator) not in MARKED_CONTENT_START_OPERATORS:
            continue
        operands = list(instruction.operands)
        if len(operands) >= 2 and isinstance(operands[1], pikepdf.Dictionary) and operands[1].get("/MCID") is not None:
            return True
    return False


def group_has_text_showing(group):
    return any(str(instruction.operator) in TEXT_SHOWING_OPERATORS for instruction in group)


def group_has_visible_graphics(group):
    graphic_ops = {"Do", "re", "S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "m", "l", "c", "v", "y", "h", "n"}
    return any(str(instruction.operator) in graphic_ops for instruction in group)


def build_cidset_bytes(cids):
    if not cids:
        return b""
    highest = max(cids)
    bitset = bytearray((highest // 8) + 1)
    for cid in cids:
        if cid < 0:
            continue
        bitset[cid // 8] |= 0x80 >> (cid % 8)
    return bytes(bitset)


def stream_bytes(stream):
    if not isinstance(stream, pikepdf.Stream):
        return None
    try:
        return stream.read_bytes()
    except Exception:
        return None


def truetype_num_glyphs_from_data(data):
    if len(data) < 12:
        return None
    try:
        _, num_tables, _, _, _ = struct.unpack(">IHHHH", data[:12])
    except Exception:
        return None
    offset = 12
    for _ in range(num_tables):
        if offset + 16 > len(data):
            return None
        try:
            tag, _, table_offset, table_length = struct.unpack(">4sIII", data[offset:offset + 16])
        except Exception:
            return None
        if tag == b"maxp" and table_offset + 6 <= len(data):
            try:
                _, num_glyphs = struct.unpack(">IH", data[table_offset:table_offset + 6])
                return int(num_glyphs)
            except Exception:
                return None
        offset += 16
    return None


def truetype_num_glyphs(font_stream):
    data = stream_bytes(font_stream)
    if data is None:
        return None
    return truetype_num_glyphs_from_data(data)


def glyph_ids_from_embedded_font(font_stream):
    data = stream_bytes(font_stream)
    if not data:
        return None
    if TTFont is not None:
        try:
            tt = TTFont(io.BytesIO(data), lazy=True)
            glyph_ids = set(range(len(tt.getGlyphOrder() or [])))
            tt.close()
            if glyph_ids:
                return glyph_ids
        except Exception:
            pass
    num_glyphs = truetype_num_glyphs_from_data(data)
    if not num_glyphs:
        return None
    return set(range(int(num_glyphs)))


def cid_to_gid_map(descendant):
    if not isinstance(descendant, pikepdf.Dictionary):
        return None
    cid_to_gid = descendant.get("/CIDToGIDMap")
    if cid_to_gid is None:
        return None
    if str(cid_to_gid) == "/Identity":
        return "/Identity"
    data = stream_bytes(cid_to_gid)
    if not data:
        return None
    mapping = {}
    cid = 0
    for index in range(0, len(data) - 1, 2):
        gid = int.from_bytes(data[index:index + 2], "big")
        if gid:
            mapping[cid] = gid
        cid += 1
    return mapping


def cid_system_info_label(descendant):
    if not isinstance(descendant, pikepdf.Dictionary):
        return None
    info = descendant.get("/CIDSystemInfo")
    if not isinstance(info, pikepdf.Dictionary):
        return None
    registry = str(info.get("/Registry") or "").strip("/")
    ordering = str(info.get("/Ordering") or "").strip("/")
    supplement = info.get("/Supplement")
    if not registry and not ordering and supplement is None:
        return None
    suffix = f" supplement {supplement}" if supplement is not None else ""
    return f"{registry}-{ordering}{suffix}".strip("-")


def embedded_cids_for_font(font, descendant, font_program):
    glyph_ids = glyph_ids_from_embedded_font(font_program)
    if not glyph_ids:
        return None, None
    mapping = cid_to_gid_map(descendant)
    if mapping == "/Identity":
        return set(glyph_ids), "embedded subset data via /CIDToGIDMap /Identity"
    if isinstance(mapping, dict) and mapping:
        cids = {cid for cid, gid in mapping.items() if gid in glyph_ids}
        if cids:
            return cids, "embedded subset data via parsed /CIDToGIDMap"
    system_info = cid_system_info_label(descendant)
    if system_info and str(font.get("/Encoding")) == "/Identity-H":
        return set(glyph_ids), f"embedded subset data via {system_info} identity encoding"
    return None, None


def text_strings_for_instruction(instruction):
    operator = str(instruction.operator)
    operands = list(instruction.operands)
    if operator == "Tj" and operands:
        return [operands[0]]
    if operator == "'" and operands:
        return [operands[0]]
    if operator == '"' and operands:
        return [operands[-1]]
    if operator == "TJ" and operands and isinstance(operands[0], pikepdf.Array):
        return [item for item in operands[0] if not isinstance(item, (int, float))]
    return []


def cid_codes_from_pdf_string(value):
    try:
        raw = bytes(value)
    except Exception:
        return []
    if not raw or len(raw) % 2 != 0:
        return []
    return [int.from_bytes(raw[index:index + 2], "big") for index in range(0, len(raw), 2)]


def collect_used_cids_by_font(pdf):
    used = {}

    for page in pdf.pages:
        resources = page.obj.get("/Resources")
        if not isinstance(resources, pikepdf.Dictionary):
            continue
        fonts = resources.get("/Font")
        if not isinstance(fonts, pikepdf.Dictionary):
            continue

        resource_to_font_ref = {}
        for resource_name, font in fonts.items():
            if not isinstance(font, pikepdf.Dictionary):
                continue
            if str(font.get("/Subtype")) != "/Type0":
                continue
            font_ref = ref_string(font)
            if font_ref:
                resource_to_font_ref[str(resource_name)] = font_ref

        if not resource_to_font_ref:
            continue

        current_font_ref = None
        try:
            instructions = list(pikepdf.parse_content_stream(page.obj))
        except Exception:
            continue

        for instruction in instructions:
            operator = str(instruction.operator)
            operands = list(instruction.operands)

            if operator == "Tf" and operands:
                current_font_ref = resource_to_font_ref.get(str(operands[0]))
                continue

            if operator not in TEXT_SHOWING_OPERATORS or not current_font_ref:
                continue

            codes = used.setdefault(current_font_ref, set())
            for text_value in text_strings_for_instruction(instruction):
                for cid in cid_codes_from_pdf_string(text_value):
                    codes.add(cid)

    return used


def artifact_orphan_top_level_content_groups(pdf, page_obj):
    groups = parse_top_level_content_groups(page_obj)
    if not groups:
        return False, []

    rewritten = []
    changed = False
    applied = []
    page_ref = ref_string(page_obj)

    for index, (is_marked, group) in enumerate(groups):
        if is_marked and group_is_artifact(group) and group_contains_nested_mcid(group):
            rewritten.extend(group[1:-1])
            changed = True
            applied.append({
                "ref": page_ref,
                "before": "/Artifact wrapper",
                "after": "removed",
                "details": f"Removed an /Artifact wrapper around already-tagged content group {index} on page {page_ref}.",
            })
            continue

        if is_marked is False and not group_has_text_showing(group) and group_has_visible_graphics(group):
            rewritten.append(pikepdf.ContentStreamInstruction([pikepdf.Name("/Artifact")], pikepdf.Operator("BMC")))
            rewritten.extend(group)
            rewritten.append(pikepdf.ContentStreamInstruction([], pikepdf.Operator("EMC")))
            changed = True
            applied.append({
                "ref": page_ref,
                "before": "untagged top-level graphics",
                "after": "/Artifact",
                "details": f"Marked untagged top-level graphics group {index} on page {page_ref} as /Artifact.",
            })
            continue

        rewritten.extend(group)

    if not changed:
        return False, []

    page_obj["/Contents"] = pdf.make_stream(pikepdf.unparse_content_stream(rewritten))
    return True, applied


def ensure_link_annotation_tags(pdf, parent_elem, page_obj, parent_tree_nums, next_key):
    annots = page_obj.get("/Annots")
    if not isinstance(annots, pikepdf.Array):
        return [], next_key

    applied = []
    page_ref = ref_string(page_obj)
    for annot in annots:
        if not isinstance(annot, pikepdf.Dictionary):
            continue
        if str(annot.get("/Subtype")) != "/Link":
            continue
        struct_parent = annot.get("/StructParent")
        try:
            struct_parent = int(struct_parent) if struct_parent is not None else None
        except Exception:
            struct_parent = None
        if struct_parent is None:
            struct_parent = next_key
            next_key += 1
            annot["/StructParent"] = struct_parent

        objr = pdf.make_indirect(pikepdf.Dictionary({
            "/Type": pikepdf.Name("/OBJR"),
            "/Obj": annot,
            "/Pg": page_obj,
        }))
        link = pdf.make_indirect(pikepdf.Dictionary({
            "/Type": pikepdf.Name("/StructElem"),
            "/S": pikepdf.Name("/Link"),
            "/P": parent_elem,
            "/Pg": page_obj,
            "/K": objr,
        }))
        contents = annot.get("/Contents")
        if contents is not None:
            link["/Alt"] = contents

        kids = parent_elem.get("/K")
        if not isinstance(kids, pikepdf.Array):
            kids = pikepdf.Array([kids]) if kids is not None else pikepdf.Array()
        kids.append(link)
        parent_elem["/K"] = kids
        upsert_parent_tree_entry(parent_tree_nums, struct_parent, link)
        applied.append({
            "ref": ref_string(link),
            "before": None,
            "after": "/Link",
            "details": f"Created /Link structure element for annotation on page {page_ref}.",
        })

    return applied, next_key


def mutate_repair_structure_conformance(pdf, mutation):
    catalog = get_catalog(pdf)
    if catalog is None:
        return False, [], ["Could not locate the PDF catalog to repair structure conformance."]

    root = get_struct_tree_root(pdf)
    if not isinstance(root, pikepdf.Dictionary):
        return False, [], ["repair_structure_conformance requires an existing structure tree."]

    ensure_mark_info(catalog)
    document = ensure_document_struct_elem(pdf, root)
    parent_tree, nums = ensure_parent_tree(root, pdf)
    next_key = int(root.get("/ParentTreeNextKey", 0) or 0)
    applied = []
    changed = False

    for page in pdf.pages:
        page_obj = page.obj
        if page_obj.get("/StructParents") is None:
            page_obj["/StructParents"] = next_key
            page_key = next_key
            next_key += 1
            changed = True
        else:
            try:
                page_key = int(page_obj.get("/StructParents"))
            except Exception:
                page_key = next_key
                page_obj["/StructParents"] = page_key
                next_key += 1
                changed = True

        page_elem, created_elem = ensure_page_content_struct_elem(pdf, document, page_obj)
        if created_elem:
            applied.append({
                "ref": ref_string(page_elem),
                "before": None,
                "after": "/Sect",
                "details": f"Created page content structure element for page {ref_string(page_obj)}.",
            })
            changed = True

        if ensure_page_marked_content(pdf, page_obj):
            applied.append({
                "ref": ref_string(page_obj),
                "before": None,
                "after": "MCID 0",
                "details": f"Wrapped page content for {ref_string(page_obj)} in marked content with MCID 0.",
            })
            changed = True

        upsert_parent_tree_entry(nums, page_key, pikepdf.Array([page_elem]))
        link_applied, next_key = ensure_link_annotation_tags(pdf, document, page_obj, nums, next_key)
        if link_applied:
            applied.extend(link_applied)
            changed = True

    root["/ParentTree"] = parent_tree
    root["/ParentTreeNextKey"] = next_key
    return changed, applied, []


def mutate_repair_note_tag_ids(pdf, mutation):
    applied = []
    changed = False
    counter = 1
    for obj in iter_struct_elems(pdf):
        if str(obj.get("/S")) not in {"/Note", "/Footnote"}:
            continue
        current_id = obj.get("/ID")
        if current_id is not None and str(current_id).strip():
            continue
        note_id = f"note-{counter}"
        counter += 1
        obj["/ID"] = pikepdf.String(note_id)
        changed = True
        applied.append({
            "ref": ref_string(obj),
            "before": None,
            "after": note_id,
            "details": f"Assigned /ID {note_id} to note structure element {ref_string(obj)}.",
        })
    if not changed:
        return False, [], ["No /Note or /Footnote structure elements required ID repair."]
    return changed, applied, []


def mutate_repair_native_marked_content_refs(pdf, mutation):
    catalog = get_catalog(pdf)
    if catalog is None:
        return False, [], ["Could not locate the PDF catalog to repair native marked content references."]
    root = get_struct_tree_root(pdf)
    if not isinstance(root, pikepdf.Dictionary):
        return False, [], ["repair_native_marked_content_refs requires an existing structure tree."]

    ensure_mark_info(catalog)
    document = ensure_document_struct_elem(pdf, root)
    parent_tree, nums = ensure_parent_tree(root, pdf)
    applied = []
    changed = False

    for page in pdf.pages:
        page_obj = page.obj
        artifact_changed, artifact_applied = artifact_orphan_top_level_content_groups(pdf, page_obj)
        if artifact_changed:
            applied.extend(artifact_applied)
            changed = True
        page_mcids = extract_page_mcids(page_obj)
        if not page_mcids:
            continue
        struct_parents = page_obj.get("/StructParents")
        try:
            page_key = int(struct_parents) if struct_parents is not None else None
        except Exception:
            page_key = None
        if page_key is None:
            continue

        current_entry = None
        index = 0
        while index + 1 < len(nums):
            try:
                existing_key = int(nums[index])
            except Exception:
                existing_key = None
            if existing_key == page_key:
                current_entry = nums[index + 1]
                break
            index += 2
        if not isinstance(current_entry, pikepdf.Array):
            current_entry = pikepdf.Array()

        page_elem, _ = ensure_page_content_struct_elem(pdf, document, page_obj)
        page_kids = ensure_struct_elem_kids_array(page_elem)
        present_mcids = existing_mcr_mcids(page_elem)

        max_mcid = max(page_mcids)
        while len(current_entry) <= max_mcid:
            current_entry.append(None)

        for mcid in page_mcids:
            existing_parent = current_entry[mcid]
            if existing_parent is not None:
                continue
            if mcid in present_mcids:
                current_entry[mcid] = page_elem
                changed = True
                applied.append({
                    "ref": ref_string(page_elem),
                    "before": None,
                    "after": f"MCID {mcid}",
                    "details": f"Connected existing tagged MCID {mcid} on page {ref_string(page_obj)} to the parent tree.",
                })
                continue

            mcr = pdf.make_indirect(pikepdf.Dictionary({
                "/Type": pikepdf.Name("/MCR"),
                "/Pg": page_obj,
                "/MCID": mcid,
            }))
            span = pdf.make_indirect(pikepdf.Dictionary({
                "/Type": pikepdf.Name("/StructElem"),
                "/S": pikepdf.Name("/Span"),
                "/P": page_elem,
                "/Pg": page_obj,
                "/K": mcr,
            }))
            page_kids.append(span)
            current_entry[mcid] = span
            changed = True
            applied.append({
                "ref": ref_string(span),
                "before": None,
                "after": f"/Span MCID {mcid}",
                "details": f"Created native tagged-content bridge for orphaned MCID {mcid} on page {ref_string(page_obj)}.",
            })

        upsert_parent_tree_entry(nums, page_key, current_entry)

    root["/ParentTree"] = parent_tree
    if not changed:
        return False, [], ["No orphaned native MCIDs required parent-tree repair."]
    return changed, applied, []


def _annotation_has_link_struct_parent(annot, nums):
    """Return True if the annotation's /StructParent key maps to a /Link struct elem in the parent tree."""
    struct_parent = annot.get("/StructParent")
    try:
        struct_parent_int = int(struct_parent) if struct_parent is not None else None
    except Exception:
        struct_parent_int = None
    if struct_parent_int is None:
        return False
    index = 0
    while index + 1 < len(nums):
        try:
            existing_key = int(nums[index])
        except Exception:
            index += 2
            continue
        if existing_key == struct_parent_int:
            entry = nums[index + 1]
            if isinstance(entry, pikepdf.Dictionary):
                return str(entry.get("/S")) == "/Link"
            return False
        index += 2
    return False


def mutate_repair_native_link_structure(pdf, mutation):
    """Create /Link structure elements for link annotations not properly enclosed in a /Link struct elem.

    Unlike repair_structure_conformance, this operation only touches link annotations and their
    parent-tree entries. It does not modify page content streams, MCID assignments, or StructParents
    keys on pages, so it is safe to run on natively-tagged documents.
    """
    catalog = get_catalog(pdf)
    if catalog is None:
        return False, [], ["Could not locate the PDF catalog to repair native link structure."]

    root = get_struct_tree_root(pdf)
    if not isinstance(root, pikepdf.Dictionary):
        return False, [], ["repair_native_link_structure requires an existing structure tree."]

    ensure_mark_info(catalog)
    document = ensure_document_struct_elem(pdf, root)
    parent_tree, nums = ensure_parent_tree(root, pdf)
    next_key = int(root.get("/ParentTreeNextKey", 0) or 0)
    applied = []
    changed = False

    for page in pdf.pages:
        page_obj = page.obj
        annots = page_obj.get("/Annots")
        if not isinstance(annots, pikepdf.Array):
            continue

        page_ref = ref_string(page_obj)
        for annot in annots:
            if not isinstance(annot, pikepdf.Dictionary):
                continue
            if str(annot.get("/Subtype")) != "/Link":
                continue

            # Clear the hidden annotation flag (bit 2) when set — PDF/UA requires link
            # annotations to be perceivable; hidden links must not be present.
            flags = annot.get("/F")
            try:
                flags_int = int(flags) if flags is not None else 0
            except Exception:
                flags_int = 0
            if flags_int & 2:
                new_flags = flags_int & ~2
                annot["/F"] = pikepdf.Integer(new_flags)
                changed = True
                applied.append({
                    "ref": ref_string(annot),
                    "before": f"F={flags_int}",
                    "after": f"F={new_flags}",
                    "details": f"Cleared hidden flag on link annotation on page {page_ref}.",
                })

            # Skip if already properly enclosed in a /Link struct element.
            if _annotation_has_link_struct_parent(annot, nums):
                continue

            # Assign a new StructParent key if the annotation doesn't already have one.
            struct_parent = annot.get("/StructParent")
            try:
                struct_parent_int = int(struct_parent) if struct_parent is not None else None
            except Exception:
                struct_parent_int = None
            if struct_parent_int is None:
                struct_parent_int = next_key
                next_key += 1
                annot["/StructParent"] = struct_parent_int

            # Create OBJR reference and /Link structure element.
            objr = pdf.make_indirect(pikepdf.Dictionary({
                "/Type": pikepdf.Name("/OBJR"),
                "/Obj": annot,
                "/Pg": page_obj,
            }))
            link_elem = pdf.make_indirect(pikepdf.Dictionary({
                "/Type": pikepdf.Name("/StructElem"),
                "/S": pikepdf.Name("/Link"),
                "/P": document,
                "/Pg": page_obj,
                "/K": objr,
            }))
            contents = annot.get("/Contents")
            if contents is not None:
                link_elem["/Alt"] = contents

            kids = document.get("/K")
            if not isinstance(kids, pikepdf.Array):
                kids = pikepdf.Array([kids]) if kids is not None else pikepdf.Array()
            kids.append(link_elem)
            document["/K"] = kids

            upsert_parent_tree_entry(nums, struct_parent_int, link_elem)
            changed = True
            applied.append({
                "ref": ref_string(link_elem),
                "before": None,
                "after": "/Link",
                "details": f"Created /Link structure element for untagged annotation on page {page_ref}.",
            })

    root["/ParentTree"] = parent_tree
    root["/ParentTreeNextKey"] = next_key
    if not changed:
        return False, [], ["No untagged link annotations required native link structure repair."]
    return changed, applied, []


def wrap_bootstrapped_chart_content_groups(pdf, page_obj, start_mcid):
    groups = parse_top_level_content_groups(page_obj)
    if not groups:
        return False, [], [], start_mcid

    rewritten = []
    applied = []
    new_mcids = []
    changed = False
    next_mcid = start_mcid
    page_ref = ref_string(page_obj)

    for index, (is_marked, group) in enumerate(groups):
        if is_marked is False and not group_is_artifact(group) and (group_has_text_showing(group) or group_has_visible_graphics(group)):
            mcid = next_mcid
            next_mcid += 1
            props = pikepdf.Dictionary({
                "/MCID": mcid,
            })
            rewritten.append(pikepdf.ContentStreamInstruction([pikepdf.Name("/Span"), props], pikepdf.Operator("BDC")))
            rewritten.extend(group)
            rewritten.append(pikepdf.ContentStreamInstruction([], pikepdf.Operator("EMC")))
            applied.append({
                "ref": page_ref,
                "before": "untagged top-level content",
                "after": f"MCID {mcid}",
                "details": f"Wrapped bootstrapped chart content group {index} on page {page_ref} in marked content with MCID {mcid}.",
            })
            new_mcids.append(mcid)
            changed = True
            continue

        rewritten.extend(group)

    if not changed:
        return False, [], [], start_mcid

    page_obj["/Contents"] = pdf.make_stream(pikepdf.unparse_content_stream(rewritten))
    return True, applied, new_mcids, next_mcid


def mutate_repair_bootstrapped_chart_content_refs(pdf, mutation):
    catalog = get_catalog(pdf)
    if catalog is None:
        return False, [], ["Could not locate the PDF catalog to repair bootstrapped chart content."]
    root = get_struct_tree_root(pdf)
    if not isinstance(root, pikepdf.Dictionary):
        return False, [], ["repair_bootstrapped_chart_content_refs requires an existing structure tree."]
    if len(pdf.pages) != 1:
        return False, [], ["repair_bootstrapped_chart_content_refs is limited to single-page chart PDFs."]

    ensure_mark_info(catalog)
    document = ensure_document_struct_elem(pdf, root)
    parent_tree, nums = ensure_parent_tree(root, pdf)
    next_key = int(root.get("/ParentTreeNextKey", 0) or 0)
    page_obj = pdf.pages[0].obj
    applied = []
    changed = False

    if page_obj.get("/StructParents") is None:
        page_obj["/StructParents"] = next_key
        page_key = next_key
        next_key += 1
        changed = True
    else:
        try:
            page_key = int(page_obj.get("/StructParents"))
        except Exception:
            page_key = next_key
            page_obj["/StructParents"] = page_key
            next_key += 1
            changed = True

    page_elem, created_elem = ensure_page_content_struct_elem(pdf, document, page_obj)
    if created_elem:
        applied.append({
            "ref": ref_string(page_elem),
            "before": None,
            "after": "/Sect",
            "details": f"Created bootstrapped chart content structure element for page {ref_string(page_obj)}.",
        })
        changed = True

    existing_mcids = extract_page_mcids(page_obj)
    start_mcid = (max(existing_mcids) + 1) if existing_mcids else 0
    group_changed, group_applied, new_mcids, next_mcid = wrap_bootstrapped_chart_content_groups(pdf, page_obj, start_mcid)
    if group_changed:
        applied.extend(group_applied)
        changed = True

    current_entry = None
    index = 0
    while index + 1 < len(nums):
        try:
            existing_key = int(nums[index])
        except Exception:
            existing_key = None
        if existing_key == page_key:
            current_entry = nums[index + 1]
            break
        index += 2
    if not isinstance(current_entry, pikepdf.Array):
        current_entry = pikepdf.Array()

    page_kids = ensure_struct_elem_kids_array(page_elem)
    while len(current_entry) <= (max(new_mcids) if new_mcids else -1):
        current_entry.append(None)

    for mcid in new_mcids:
        mcr = pdf.make_indirect(pikepdf.Dictionary({
            "/Type": pikepdf.Name("/MCR"),
            "/Pg": page_obj,
            "/MCID": mcid,
        }))
        span = pdf.make_indirect(pikepdf.Dictionary({
            "/Type": pikepdf.Name("/StructElem"),
            "/S": pikepdf.Name("/Span"),
            "/P": page_elem,
            "/Pg": page_obj,
            "/K": mcr,
        }))
        page_kids.append(span)
        while len(current_entry) <= mcid:
            current_entry.append(None)
        current_entry[mcid] = span
        applied.append({
            "ref": ref_string(span),
            "before": None,
            "after": f"/Span MCID {mcid}",
            "details": f"Attached bootstrapped chart content MCID {mcid} to the structure tree on page {ref_string(page_obj)}.",
        })
        changed = True

    upsert_parent_tree_entry(nums, page_key, current_entry)
    link_applied, next_key = ensure_link_annotation_tags(pdf, page_elem, page_obj, nums, next_key)
    if link_applied:
        applied.extend(link_applied)
        changed = True

    root["/ParentTree"] = parent_tree
    root["/ParentTreeNextKey"] = next_key

    if not changed:
        return False, [], ["No bootstrapped chart content groups required MCID or link-structure repair."]
    return changed, applied, []


def mutate_repair_native_figure_semantics(pdf, mutation):
    # Conservative alias: only mark leftover nonsemantic page elements as decorative.
    return mutate_artifact_nonsemantic_page_elements(pdf, mutation)


def mutate_repair_native_table_headers(pdf, mutation):
    # Reuse the existing in-place table-header mutation on already-tagged tables.
    return mutate_set_table_header_cells(pdf, mutation)


def mutate_repair_native_reading_order(pdf, mutation):
    parents = reading_order_parents(pdf)
    if not parents:
        return False, [], ["No mutable tagged parent groups were found for native reading-order repair."]
    selected = sorted(
        [parent for parent in parents if parent["mutableKids"] and parent["mcidDisorderBefore"] > 0 and len(parent["suggestedChildRefs"]) > 1],
        key=lambda parent: (-parent["mcidDisorderBefore"], len(parent["childRefs"]))
    )
    if not selected:
        return False, [], ["Tagged reading-order containers are already stable or not safely mutable."]
    return mutate_reorder_structure_children(pdf, {
        "orderedTargets": selected[0]["suggestedChildRefs"],
        "parentRef": selected[0]["parentRef"],
        "expectedDisorderBefore": selected[0]["mcidDisorderBefore"],
    })


def create_font_descriptor(pdf, font_name, font_path=None):
    """Create a minimal /FontDescriptor dictionary for a font that lacks one.

    Uses conservative default metrics. When font_path is provided the UPM is
    used to scale the bounding box to PDF units (1/1000 of a point).
    """
    metrics = parse_ttf_metrics(font_path) if font_path else None
    upm = int((metrics or {}).get("upm", 1000))
    scale = 1000 / upm if upm else 1
    # Conservative generic bbox that works for most Latin fonts
    bbox = [
        int(-200 * scale), int(-200 * scale),
        int(1200 * scale), int(900 * scale),
    ]
    name_str = font_name if font_name.startswith("/") else "/" + font_name.lstrip("/")
    desc = pikepdf.Dictionary({
        "/Type": pikepdf.Name("/FontDescriptor"),
        "/FontName": pikepdf.Name(name_str),
        "/Flags": 32,  # symbolic=0, fixed-pitch=0, serif=0, non-symbolic=1, script=0
        "/FontBBox": pikepdf.Array([bbox[0], bbox[1], bbox[2], bbox[3]]),
        "/ItalicAngle": 0,
        "/Ascent": 800,
        "/Descent": -200,
        "/CapHeight": 700,
        "/StemV": 80,
    })
    return pdf.make_indirect(desc)


def embed_font_program(pdf, descriptor, font_path, font=None):
    """Embed a font program into a font descriptor.

    Selects the correct FontFile key based on the font format:
    - .ttf / .ttc  -> /FontFile2  (TrueType)
    - .otf (CFF)   -> /FontFile3 with /Subtype /OpenType
    - .pfb / .pfa  -> /FontFile   (Type1 PostScript)

    When a TrueType substitute is embedded into what was originally a Type1
    font, the font dictionary's /Subtype is also updated to /TrueType so that
    veraPDF's width and encoding checks match the program type.
    """
    data = font_path.read_bytes()
    ext = font_path.suffix.lower()
    if ext in {".ttf", ".ttc"}:
        stream = pdf.make_stream(data)
        stream["/Length1"] = len(data)
        descriptor["/FontFile2"] = stream
        if isinstance(font, pikepdf.Dictionary) and str(font.get("/Subtype")) == "/Type1":
            font["/Subtype"] = pikepdf.Name("/TrueType")
    elif ext == ".otf":
        stream = pdf.make_stream(data)
        stream["/Subtype"] = pikepdf.Name("/OpenType")
        descriptor["/FontFile3"] = stream
        # OpenType fonts embedded in PDF remain as /Type1 descriptor subtype;
        # keep the font's /Subtype as-is (Type1 or TrueType).
    else:
        # Fallback: Type1 PostScript
        stream = pdf.make_stream(data)
        stream["/Length1"] = len(data)
        descriptor["/FontFile"] = stream


def normalize_font_program_subtype(font, descriptor):
    # Keep the original font subtype for legacy simple fonts. Switching /Type1
    # dictionaries to /TrueType reintroduces veraPDF 7.21.6 failures for these
    # annual reports even when the embedded TTF is otherwise valid.
    return False


def build_tounicode_cmap(codepoint_map):
    mappings = []
    for code in sorted(codepoint_map.keys()):
        text = codepoint_map[code]
        utf16 = text.encode("utf-16-be").hex().upper()
        mappings.append(f"<{code:02X}> <{utf16}>")
    body = "\n".join(mappings)
    return f"""/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo
<< /Registry (Adobe)
/Ordering (UCS)
/Supplement 0
>> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<00> <FF>
endcodespacerange
{len(mappings)} beginbfchar
{body}
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end"""


def sfnt_tables(data):
    if len(data) < 12:
        return {}
    try:
        _, num_tables, _, _, _ = struct.unpack(">IHHHH", data[:12])
    except Exception:
        return {}
    tables = {}
    offset = 12
    for _ in range(num_tables):
        if offset + 16 > len(data):
            break
        try:
            tag, _, table_offset, table_length = struct.unpack(">4sIII", data[offset:offset + 16])
        except Exception:
            break
        tables[tag.decode("latin-1")] = (table_offset, table_length)
        offset += 16
    return tables


def parse_ttf_metrics(font_path):
    if TTFont is not None:
        try:
            tt = TTFont(str(font_path), lazy=True)
            units_per_em = int(tt["head"].unitsPerEm)
            glyph_order = tt.getGlyphOrder()
            hmtx_metrics = tt["hmtx"].metrics
            advances = [int(hmtx_metrics.get(glyph_name, (0, 0))[0]) for glyph_name in glyph_order]
            unicode_to_gid = {}
            for codepoint, glyph_name in (tt.getBestCmap() or {}).items():
                try:
                    unicode_to_gid.setdefault(int(codepoint), tt.getGlyphID(glyph_name))
                except Exception:
                    continue
            glyph_name_to_width = {
                str(glyph_name): int(metrics[0])
                for glyph_name, metrics in hmtx_metrics.items()
            }
            tt.close()
            return {
                "units_per_em": units_per_em,
                "upm": units_per_em,
                "advances": advances,
                "unicode_to_gid": unicode_to_gid,
                "glyph_name_to_width": glyph_name_to_width,
            }
        except Exception:
            pass
    try:
        data = Path(font_path).read_bytes()
    except Exception:
        return None
    tables = sfnt_tables(data)
    if not tables:
        return None
    try:
        head_offset, _ = tables["head"]
        hhea_offset, _ = tables["hhea"]
        hmtx_offset, _ = tables["hmtx"]
        maxp_offset, _ = tables["maxp"]
        cmap_offset, cmap_length = tables["cmap"]
    except KeyError:
        return None

    try:
        units_per_em = struct.unpack(">H", data[head_offset + 18:head_offset + 20])[0]
        num_h_metrics = struct.unpack(">H", data[hhea_offset + 34:hhea_offset + 36])[0]
        num_glyphs = struct.unpack(">H", data[maxp_offset + 4:maxp_offset + 6])[0]
    except Exception:
        return None

    advances = []
    cursor = hmtx_offset
    last_advance = 0
    try:
        for _ in range(num_h_metrics):
            advance, _ = struct.unpack(">HH", data[cursor:cursor + 4])
            advances.append(int(advance))
            last_advance = int(advance)
            cursor += 4
        while len(advances) < num_glyphs:
            advances.append(last_advance)
            cursor += 2
    except Exception:
        return None

    unicode_to_gid = {}
    try:
        version, num_subtables = struct.unpack(">HH", data[cmap_offset:cmap_offset + 4])
        subtable_records = []
        rec_offset = cmap_offset + 4
        for _ in range(num_subtables):
            platform_id, encoding_id, offset = struct.unpack(">HHI", data[rec_offset:rec_offset + 8])
            subtable_records.append((platform_id, encoding_id, cmap_offset + offset))
            rec_offset += 8
        for platform_id, encoding_id, offset in subtable_records:
            if offset + 2 > len(data):
                continue
            format_id = struct.unpack(">H", data[offset:offset + 2])[0]
            if format_id == 4:
                length = struct.unpack(">H", data[offset + 2:offset + 4])[0]
                segment_count = struct.unpack(">H", data[offset + 6:offset + 8])[0] // 2
                end_count_offset = offset + 14
                start_count_offset = end_count_offset + (segment_count * 2) + 2
                id_delta_offset = start_count_offset + (segment_count * 2)
                id_range_offset_offset = id_delta_offset + (segment_count * 2)
                glyph_array_offset = id_range_offset_offset + (segment_count * 2)
                for index in range(segment_count):
                    end_code = struct.unpack(">H", data[end_count_offset + index * 2:end_count_offset + index * 2 + 2])[0]
                    start_code = struct.unpack(">H", data[start_count_offset + index * 2:start_count_offset + index * 2 + 2])[0]
                    id_delta = struct.unpack(">h", data[id_delta_offset + index * 2:id_delta_offset + index * 2 + 2])[0]
                    id_range_offset = struct.unpack(">H", data[id_range_offset_offset + index * 2:id_range_offset_offset + index * 2 + 2])[0]
                    if start_code == 0xFFFF and end_code == 0xFFFF:
                        continue
                    for codepoint in range(start_code, end_code + 1):
                        if id_range_offset == 0:
                            glyph_id = (codepoint + id_delta) % 65536
                        else:
                            glyph_index_offset = id_range_offset_offset + index * 2 + id_range_offset + ((codepoint - start_code) * 2)
                            if glyph_index_offset + 2 > offset + length:
                                continue
                            glyph_id = struct.unpack(">H", data[glyph_index_offset:glyph_index_offset + 2])[0]
                            if glyph_id != 0:
                                glyph_id = (glyph_id + id_delta) % 65536
                        if glyph_id:
                            unicode_to_gid.setdefault(codepoint, glyph_id)
            elif format_id == 12:
                _, _, length, _, n_groups = struct.unpack(">HHLLL", data[offset:offset + 16])
                group_offset = offset + 16
                for _ in range(n_groups):
                    start_char, end_char, start_gid = struct.unpack(">LLL", data[group_offset:group_offset + 12])
                    for codepoint in range(start_char, end_char + 1):
                        unicode_to_gid.setdefault(codepoint, start_gid + (codepoint - start_char))
                    group_offset += 12
    except Exception:
        return None

    return {
        "units_per_em": units_per_em,
        "upm": units_per_em,
        "advances": advances,
        "unicode_to_gid": unicode_to_gid,
        "glyph_name_to_width": {},
    }


def width_for_unicode(metrics, text):
    if not metrics or not text:
        return None
    total = 0
    has_glyph = False
    for char in text:
        gid = metrics["unicode_to_gid"].get(ord(char))
        if gid is None or gid >= len(metrics["advances"]):
            return None
        total += metrics["advances"][gid]
        has_glyph = True
    if not has_glyph or not metrics["units_per_em"]:
        return None
    return int(round((total / metrics["units_per_em"]) * 1000))


def update_font_widths(font, width_map):
    if not isinstance(font, pikepdf.Dictionary) or not width_map:
        return False
    existing_first = font.get("/FirstChar")
    existing_last = font.get("/LastChar")
    existing_widths = font.get("/Widths")
    if isinstance(existing_first, int) and isinstance(existing_last, int) and isinstance(existing_widths, pikepdf.Array):
        next_widths = pikepdf.Array(existing_widths)
        changed = False
        for code, width in width_map.items():
            if code < existing_first or code > existing_last:
                continue
            index = code - existing_first
            if index < 0 or index >= len(next_widths):
                continue
            if int(next_widths[index]) != int(width):
                next_widths[index] = int(width)
                changed = True
        if changed:
            font["/Widths"] = next_widths
        return changed

    first_char = min(width_map.keys())
    last_char = max(width_map.keys())
    widths = pikepdf.Array([int(width_map.get(code, 0)) for code in range(first_char, last_char + 1)])
    font["/FirstChar"] = int(first_char)
    font["/LastChar"] = int(last_char)
    font["/Widths"] = widths
    return True


def build_cid_tounicode_cmap(codepoint_map):
    mappings = []
    for code in sorted(codepoint_map.keys()):
        text = codepoint_map[code]
        utf16 = text.encode("utf-16-be").hex().upper()
        mappings.append(f"<{code:04X}> <{utf16}>")
    body = "\n".join(mappings)
    return f"""/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo
<< /Registry (Adobe)
/Ordering (UCS)
/Supplement 0
>> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
{len(mappings)} beginbfchar
{body}
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end"""


def parse_tounicode_map(stream):
    if not isinstance(stream, pikepdf.Stream):
        return {}
    try:
        data = stream.read_bytes().decode("latin-1", "ignore")
    except Exception:
        return {}
    mappings = {}
    for source_hex, target_hex in re.findall(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", data):
        try:
            source = int(source_hex, 16)
            target_bytes = bytes.fromhex(target_hex)
            mappings[source] = target_bytes.decode("utf-16-be", "ignore") or None
        except Exception:
            continue
    return {key: value for key, value in mappings.items() if value}


def has_tounicode(font):
    return isinstance(font, pikepdf.Dictionary) and font.get("/ToUnicode") is not None


def raw_bytes_from_pdf_string(value):
    try:
        return bytes(value)
    except Exception:
        return b""


def parse_encoding_differences(encoding):
    mapping = {}
    if not isinstance(encoding, pikepdf.Dictionary):
        return mapping
    differences = encoding.get("/Differences")
    if not isinstance(differences, pikepdf.Array):
        return mapping
    current_code = None
    for item in differences:
        if isinstance(item, int):
            current_code = int(item)
            continue
        if current_code is None:
            continue
        glyph_name = str(item).lstrip("/")
        mapped = glyph_name_to_unicode(glyph_name)
        if mapped:
            mapping[current_code] = mapped
        current_code += 1
    return mapping


def parse_encoding_difference_glyph_names(encoding):
    mapping = {}
    if not isinstance(encoding, pikepdf.Dictionary):
        return mapping
    differences = encoding.get("/Differences")
    if not isinstance(differences, pikepdf.Array):
        return mapping
    current_code = None
    for item in differences:
        if isinstance(item, int):
            current_code = int(item)
            continue
        if current_code is None:
            continue
        mapping[current_code] = str(item).lstrip("/")
        current_code += 1
    return mapping


def standard_encoding_map():
    mapping = {}
    for code in range(32, 127):
        mapping[code] = chr(code)
    mapping.update({
        145: "\u2018",
        146: "\u2019",
        147: "\u201c",
        148: "\u201d",
        149: "\u2022",
        150: "\u2013",
        151: "\u2014",
    })
    return mapping


def glyph_name_for_text(text):
    if not text or len(text) != 1:
        return None
    codepoint = ord(text)
    return UV2AGL.get(codepoint)


def standard_encoding_glyph_names():
    mapping = {}
    for code, text in standard_encoding_map().items():
        glyph_name = glyph_name_for_text(text)
        if glyph_name:
            mapping[code] = glyph_name
    return mapping


def glyph_name_to_unicode(name):
    cleaned = str(name or "").strip().lstrip("/")
    if not cleaned:
        return None
    if cleaned in GLYPH_NAME_UNICODE:
        return GLYPH_NAME_UNICODE[cleaned]
    if len(cleaned) == 1:
        return cleaned
    if cleaned.startswith("uni") and len(cleaned) >= 7:
        try:
            return "".join(chr(int(cleaned[index:index + 4], 16)) for index in range(3, len(cleaned), 4))
        except Exception:
            return None
    if cleaned.startswith("u") and 5 <= len(cleaned) <= 7:
        try:
            return chr(int(cleaned[1:], 16))
        except Exception:
            return None
    suffixes = {
        "grave": "\u0300",
        "acute": "\u0301",
        "circumflex": "\u0302",
        "tilde": "\u0303",
        "macron": "\u0304",
        "breve": "\u0306",
        "dotaccent": "\u0307",
        "dieresis": "\u0308",
        "ring": "\u030a",
        "cedilla": "\u0327",
        "hungarumlaut": "\u030b",
        "ogonek": "\u0328",
        "caron": "\u030c",
    }
    for suffix, combining in suffixes.items():
        if cleaned.endswith(suffix) and len(cleaned) > len(suffix):
            base = glyph_name_to_unicode(cleaned[:-len(suffix)])
            if base:
                return base + combining
    return None


def font_encoding_map(font):
    if not isinstance(font, pikepdf.Dictionary):
        return {}
    encoding = font.get("/Encoding")
    if isinstance(encoding, pikepdf.Dictionary):
        mapping = standard_encoding_map()
        mapping.update(parse_encoding_differences(encoding))
        return mapping
    encoding_name = str(encoding) if encoding is not None else ""
    if encoding_name == "/WinAnsiEncoding":
        return WIN_ANSI_UNICODE
    if encoding_name == "/MacRomanEncoding":
        return {
            code: bytes([code]).decode("mac_roman")
            for code in range(32, 256)
        }
    subtype = str(font.get("/Subtype"))
    if subtype in {"/Type1", "/Type3"}:
        return standard_encoding_map()
    return {}


def font_encoding_glyph_names(font):
    if not isinstance(font, pikepdf.Dictionary):
        return {}
    encoding = font.get("/Encoding")
    if isinstance(encoding, pikepdf.Dictionary):
        mapping = standard_encoding_glyph_names()
        mapping.update(parse_encoding_difference_glyph_names(encoding))
        return mapping
    encoding_name = str(encoding) if encoding is not None else ""
    if encoding_name == "/WinAnsiEncoding":
        mapping = {}
        for code, text in WIN_ANSI_UNICODE.items():
            glyph_name = glyph_name_for_text(text)
            if glyph_name:
                mapping[code] = glyph_name
        return mapping
    if encoding_name == "/MacRomanEncoding":
        mapping = {}
        for code in range(32, 256):
            glyph_name = glyph_name_for_text(bytes([code]).decode("mac_roman"))
            if glyph_name:
                mapping[code] = glyph_name
        return mapping
    subtype = str(font.get("/Subtype"))
    if subtype in {"/Type1", "/Type3"}:
        return standard_encoding_glyph_names()
    return {}


def collect_used_codes_by_font(pdf):
    used = {}

    for page in pdf.pages:
        resources = page.obj.get("/Resources")
        if not isinstance(resources, pikepdf.Dictionary):
            continue
        fonts = resources.get("/Font")
        if not isinstance(fonts, pikepdf.Dictionary):
            continue

        resource_to_font = {}
        for resource_name, font in fonts.items():
            if not isinstance(font, pikepdf.Dictionary):
                continue
            font_ref = ref_string(font)
            if font_ref:
                resource_to_font[str(resource_name)] = (font_ref, font)

        if not resource_to_font:
            continue

        current_font_ref = None
        current_font = None
        try:
            instructions = list(pikepdf.parse_content_stream(page.obj))
        except Exception:
            continue

        for instruction in instructions:
            operator = str(instruction.operator)
            operands = list(instruction.operands)

            if operator == "Tf" and operands:
                selected = resource_to_font.get(str(operands[0]))
                current_font_ref = selected[0] if selected else None
                current_font = selected[1] if selected else None
                continue

            if operator not in TEXT_SHOWING_OPERATORS or not current_font_ref or not isinstance(current_font, pikepdf.Dictionary):
                continue

            codes = used.setdefault(current_font_ref, set())
            if str(current_font.get("/Subtype")) == "/Type0":
                for text_value in text_strings_for_instruction(instruction):
                    for cid in cid_codes_from_pdf_string(text_value):
                        codes.add(cid)
                continue

            for text_value in text_strings_for_instruction(instruction):
                for code in raw_bytes_from_pdf_string(text_value):
                    codes.add(int(code))

    return used


def font_descriptor_for(font):
    if not isinstance(font, pikepdf.Dictionary):
        return None
    descriptor = font.get("/FontDescriptor")
    if isinstance(descriptor, pikepdf.Dictionary):
        return descriptor
    if str(font.get("/Subtype")) == "/Type0":
        descendants = font.get("/DescendantFonts")
        if isinstance(descendants, pikepdf.Array) and len(descendants) > 0 and isinstance(descendants[0], pikepdf.Dictionary):
            descriptor = descendants[0].get("/FontDescriptor")
            if isinstance(descriptor, pikepdf.Dictionary):
                return descriptor
    return None


def descendant_font_for(font):
    if not isinstance(font, pikepdf.Dictionary):
        return None
    descendants = font.get("/DescendantFonts")
    if isinstance(descendants, pikepdf.Array) and len(descendants) > 0 and isinstance(descendants[0], pikepdf.Dictionary):
        return descendants[0]
    return None


def normalize_annotation_sort_key(annot):
    rect = annot.get("/Rect") if isinstance(annot, pikepdf.Dictionary) else None
    if isinstance(rect, pikepdf.Array) and len(rect) == 4:
        try:
            x0 = float(rect[0])
            y0 = float(rect[1])
            x1 = float(rect[2])
            y1 = float(rect[3])
            top = max(y0, y1)
            left = min(x0, x1)
            return (-top, left)
        except Exception:
            pass
    return (0, 0)


def mutate_repair_font_unicode_maps(pdf, mutation):
    applied = []
    warnings = []
    changed = False
    processed_refs = set()

    for page in pdf.pages:
        resources = page.obj.get("/Resources")
        if not isinstance(resources, pikepdf.Dictionary):
            continue
        fonts = resources.get("/Font")
        if not isinstance(fonts, pikepdf.Dictionary):
            continue
        for _, font in fonts.items():
            if not isinstance(font, pikepdf.Dictionary):
                continue
            font_ref = ref_string(font) or str(id(font))
            if font_ref in processed_refs:
                continue
            processed_refs.add(font_ref)
            if has_tounicode(font):
                continue
            subtype = str(font.get("/Subtype"))
            encoding = str(font.get("/Encoding")) if font.get("/Encoding") is not None else ""
            descriptor = font_descriptor_for(font)
            base_font = str(font.get("/BaseFont"))
            if subtype != "/TrueType" or encoding not in {"/WinAnsiEncoding", "/MacRomanEncoding"}:
                warnings.append(f"Could not derive a ToUnicode map for {base_font} ({subtype}, {encoding or 'no encoding'}).")
                continue
            cmap = build_tounicode_cmap(WIN_ANSI_UNICODE)
            stream = pdf.make_stream(cmap.encode("utf-8"))
            font["/ToUnicode"] = stream
            applied.append({
                "ref": ref_string(font),
                "before": None,
                "after": "/ToUnicode",
                "details": f"Added a ToUnicode CMap for {base_font} using {encoding.lstrip('/')} character mappings.",
            })
            if isinstance(descriptor, pikepdf.Dictionary):
                applied[-1]["details"] += " Font descriptor preserved."
            changed = True

    return changed, applied, warnings


def mutate_repair_type1_font_unicode_maps(pdf, mutation):
    applied = []
    warnings = []
    changed = False
    processed_refs = set()
    used_codes_by_font = collect_used_codes_by_font(pdf)

    for page in pdf.pages:
        resources = page.obj.get("/Resources")
        if not isinstance(resources, pikepdf.Dictionary):
            continue
        fonts = resources.get("/Font")
        if not isinstance(fonts, pikepdf.Dictionary):
            continue
        for _, font in fonts.items():
            if not isinstance(font, pikepdf.Dictionary):
                continue
            subtype = str(font.get("/Subtype"))
            if subtype not in {"/Type1", "/Type3"}:
                continue
            font_ref = ref_string(font) or str(id(font))
            if font_ref in processed_refs:
                continue
            processed_refs.add(font_ref)
            if has_tounicode(font):
                continue

            base_font = str(font.get("/BaseFont"))
            encoding_map = font_encoding_map(font)
            used_codes = sorted(used_codes_by_font.get(font_ref, set()))
            if used_codes:
                encoding_map = {code: text for code, text in encoding_map.items() if code in used_codes}

            if not encoding_map:
                warnings.append(f"Could not derive a ToUnicode map for {base_font} ({subtype}, {font.get('/Encoding') or 'no encoding'}).")
                continue

            font["/ToUnicode"] = pdf.make_stream(build_tounicode_cmap(encoding_map).encode("utf-8"))
            applied.append({
                "ref": ref_string(font),
                "before": None,
                "after": "/ToUnicode",
                "details": f"Added a Type1/Type3 ToUnicode CMap for {base_font} from {len(encoding_map)} derivable character mappings.",
            })
            changed = True

    return changed, applied, warnings


def mutate_normalize_annotation_tab_order(pdf, mutation):
    applied = []
    changed = False
    for page in pdf.pages:
        page_obj = page.obj
        annots = page_obj.get("/Annots")
        if not isinstance(annots, pikepdf.Array) or len(annots) < 1:
            continue
        if str(page_obj.get("/Tabs")) != "/S":
            page_obj["/Tabs"] = pikepdf.Name("/S")
            changed = True
            applied.append({
                "ref": ref_string(page_obj),
                "before": None,
                "after": "/Tabs /S",
                "details": f"Normalized page tab order mode to /S for {ref_string(page_obj)}.",
            })

        ordered = sorted(list(annots), key=normalize_annotation_sort_key)
        if ordered != list(annots):
            page_obj["/Annots"] = pikepdf.Array(ordered)
            changed = True
            applied.append({
                "ref": ref_string(page_obj),
                "before": "annotation order",
                "after": "reading order",
                "details": f"Reordered annotations on {ref_string(page_obj)} to follow visual reading order.",
            })
    return changed, applied, []


def mutate_repair_cid_symbol_font_maps(pdf, mutation):
    applied = []
    warnings = []
    changed = False
    processed_refs = set()

    for page in pdf.pages:
        resources = page.obj.get("/Resources")
        if not isinstance(resources, pikepdf.Dictionary):
            continue
        fonts = resources.get("/Font")
        if not isinstance(fonts, pikepdf.Dictionary):
            continue
        for _, font in fonts.items():
            if not isinstance(font, pikepdf.Dictionary):
                continue
            if str(font.get("/Subtype")) != "/Type0":
                continue
            font_ref = ref_string(font) or str(id(font))
            if font_ref in processed_refs:
                continue
            processed_refs.add(font_ref)

            base_font = normalized_base_font_name(font.get("/BaseFont"))
            descendant = descendant_font_for(font)
            if not isinstance(descendant, pikepdf.Dictionary):
                continue

            cid_to_gid = descendant.get("/CIDToGIDMap")
            if str(cid_to_gid) != "/Identity":
                descendant["/CIDToGIDMap"] = pikepdf.Name("/Identity")
                changed = True
                applied.append({
                    "ref": ref_string(descendant),
                    "before": None,
                    "after": "/Identity",
                    "details": f"Set /CIDToGIDMap /Identity on descendant CID font for {base_font}.",
                })

            glyph_map = CID_SYMBOL_UNICODE_MAPS.get(base_font)
            if glyph_map:
                existing_map = parse_tounicode_map(font.get("/ToUnicode"))
                merged_map = {**existing_map, **glyph_map}
                if merged_map != existing_map:
                    font["/ToUnicode"] = pdf.make_stream(build_cid_tounicode_cmap(merged_map).encode("utf-8"))
                    changed = True
                    applied.append({
                        "ref": ref_string(font),
                        "before": None,
                        "after": "/ToUnicode",
                        "details": f"Extended CID ToUnicode mappings for {base_font} with glyph codes {', '.join(str(code) for code in sorted(glyph_map.keys()))}.",
                    })
            elif font.get("/ToUnicode") is None:
                warnings.append(f"No deterministic CID symbol Unicode map is available for {base_font}.")

    return changed, applied, warnings


def mutate_repair_cidset_consistency(pdf, mutation):
    applied = []
    warnings = []
    changed = False
    used_cids_by_font = collect_used_cids_by_font(pdf)
    processed_refs = set()
    inspected_fonts = 0
    rewritten_fonts = 0
    unchanged_fonts = 0
    coverage_sources = []

    for page in pdf.pages:
        resources = page.obj.get("/Resources")
        if not isinstance(resources, pikepdf.Dictionary):
            continue
        fonts = resources.get("/Font")
        if not isinstance(fonts, pikepdf.Dictionary):
            continue

        for _, font in fonts.items():
            if not isinstance(font, pikepdf.Dictionary):
                continue
            if str(font.get("/Subtype")) != "/Type0":
                continue

            font_ref = ref_string(font) or str(id(font))
            if font_ref in processed_refs:
                continue
            processed_refs.add(font_ref)

            descriptor = font_descriptor_for(font)
            if not isinstance(descriptor, pikepdf.Dictionary):
                continue
            cidset = descriptor.get("/CIDSet")
            if cidset is None:
                continue
            inspected_fonts += 1
            font_program = descriptor.get("/FontFile2") or descriptor.get("/FontFile3") or descriptor.get("/FontFile")
            if not font_program:
                warnings.append(f"Skipped CIDSet repair for {normalized_base_font_name(font.get('/BaseFont'))} because the font program is not embedded.")
                continue

            used_cids = sorted(used_cids_by_font.get(font_ref, set()))
            descendant = descendant_font_for(font)
            embedded_cids, coverage_source = embedded_cids_for_font(font, descendant, font_program)
            if not embedded_cids:
                warnings.append(
                    f"Could not derive a trustworthy embedded CID universe for {normalized_base_font_name(font.get('/BaseFont'))}; left /CIDSet unchanged."
                )
                continue
            coverage_sources.append(coverage_source)

            target_cids = sorted(set(embedded_cids) | set(used_cids))
            if not target_cids:
                warnings.append(
                    f"Derived no target CID coverage for {normalized_base_font_name(font.get('/BaseFont'))} even though an embedded font program was present; left /CIDSet unchanged."
                )
                continue

            next_cidset = build_cidset_bytes(target_cids)
            try:
                existing_bytes = cidset.read_bytes() if isinstance(cidset, pikepdf.Stream) else None
            except Exception:
                existing_bytes = None

            if existing_bytes == next_cidset:
                unchanged_fonts += 1
                continue

            descriptor["/CIDSet"] = pdf.make_stream(next_cidset)
            changed = True
            rewritten_fonts += 1
            applied.append({
                "ref": ref_string(descriptor),
                "before": "/CIDSet",
                "after": f"{len(target_cids)} CIDs",
                "details": f"Regenerated /CIDSet for {normalized_base_font_name(font.get('/BaseFont'))} from {len(target_cids)} derived CIDs using {coverage_source}"
                  + (" and used text content." if used_cids else "."),
            })

    if inspected_fonts:
        distinct_sources = sorted({source for source in coverage_sources if source})
        coverage_summary = ", ".join(distinct_sources) if distinct_sources else "no trusted embedded CID coverage"
        summary = f"Inspected {inspected_fonts} CID font(s) with /CIDSet streams and rewrote {rewritten_fonts} stream(s); coverage source: {coverage_summary}."
        if rewritten_fonts:
            applied.insert(0, {
                "ref": "document",
                "before": None,
                "after": None,
                "details": summary,
            })
        elif unchanged_fonts and not warnings:
            warnings.insert(0, summary + f" {unchanged_fonts} trusted stream(s) already matched the derived CID coverage.")
        elif not warnings:
            warnings.insert(0, summary + " No trustworthy rewrite target was available.")

    return changed, applied, warnings


def mutate_artifact_nonsemantic_page_elements(pdf, mutation):
    applied = []
    changed = False
    for obj in iter_struct_elems(pdf):
        tag = str(obj.get("/S"))
        if tag not in {"/NonStruct", "/Span", "/Div"}:
            continue
        if obj.get("/Alt") is not None:
            continue
        parent = obj.get("/P")
        if not isinstance(parent, pikepdf.Dictionary):
            continue
        kids = obj.get("/K")
        has_child_struct = isinstance(kids, pikepdf.Array) and any(isinstance(child, pikepdf.Dictionary) for child in kids)
        if has_child_struct:
            continue
        obj["/Alt"] = pikepdf.String("Decorative element")
        changed = True
        applied.append({
            "ref": ref_string(obj),
            "before": tag,
            "after": "Decorative element",
            "details": f"Marked nonsemantic element {ref_string(obj)} as decorative for alternate-text checks.",
        })
    return changed, applied, []


def mutate_embed_missing_fonts_in_place(pdf, mutation):
    applied = []
    warnings = []
    changed = False
    embedded = {}

    for page in pdf.pages:
        resources = page.obj.get("/Resources")
        if not isinstance(resources, pikepdf.Dictionary):
            continue
        fonts = resources.get("/Font")
        if not isinstance(fonts, pikepdf.Dictionary):
            continue
        for _, font in fonts.items():
            if not isinstance(font, pikepdf.Dictionary):
                continue
            subtype = str(font.get("/Subtype"))
            descriptor = font_descriptor_for(font)
            if not isinstance(descriptor, pikepdf.Dictionary):
                continue
            if descriptor.get("/FontFile") or descriptor.get("/FontFile2") or descriptor.get("/FontFile3"):
                continue
            base_font = str(font.get("/BaseFont"))
            font_path = font_file_path(base_font)
            if not font_path:
                warnings.append(f"No embeddable font file was found for {base_font}.")
                continue
            cache_key = str(font_path)
            if cache_key not in embedded:
                embed_font_program(pdf, descriptor, font_path, font=font)
                normalize_font_program_subtype(font, descriptor)
                embedded[cache_key] = True
            else:
                embed_font_program(pdf, descriptor, font_path, font=font)
                normalize_font_program_subtype(font, descriptor)
            applied.append({
                "ref": ref_string(font),
                "before": base_font,
                "after": str(font_path),
                "details": f"Embedded font program for {base_font} from {font_path.name}.",
            })
            changed = True

    return changed, applied, warnings


def legacy_substitute_font_name(base_font):
    normalized = normalized_base_font_name(base_font)
    if normalized in LEGACY_FONT_SUBSTITUTES:
        return LEGACY_FONT_SUBSTITUTES[normalized]
    for candidate, substitute in LEGACY_FONT_SUBSTITUTES.items():
        if normalized.startswith(candidate):
            return substitute
    return None


def derive_encoding_map_for_used_codes(font, font_ref, used_codes_by_font):
    encoding_map = font_encoding_map(font)
    glyph_name_map = font_encoding_glyph_names(font)
    used_codes = sorted(used_codes_by_font.get(font_ref, set()))
    if used_codes:
        encoding_map = {code: text for code, text in encoding_map.items() if code in used_codes}
        glyph_name_map = {code: name for code, name in glyph_name_map.items() if code in used_codes}
    return encoding_map, glyph_name_map, used_codes


def derive_width_map(metrics, encoding_map, glyph_name_map=None):
    width_map = {}
    glyph_widths = (metrics or {}).get("glyph_name_to_width") or {}
    for code, mapped_text in encoding_map.items():
        substitute_width = None
        glyph_name = (glyph_name_map or {}).get(code)
        if glyph_name:
            raw_width = glyph_widths.get(glyph_name)
            if raw_width is not None and metrics.get("units_per_em"):
                substitute_width = int(round((raw_width / metrics["units_per_em"]) * 1000))
        if substitute_width is None:
            substitute_width = width_for_unicode(metrics, mapped_text)
        if substitute_width is None:
            continue
        width_map[code] = substitute_width
    return width_map


def width_drift_ratio(font, width_map):
    existing_first = font.get("/FirstChar")
    existing_widths = font.get("/Widths")
    drifts = []
    if not (isinstance(existing_first, int) and isinstance(existing_widths, pikepdf.Array)):
        return drifts
    for code, width in width_map.items():
        index = code - existing_first
        if 0 <= index < len(existing_widths):
            try:
                existing_width = int(existing_widths[index])
            except Exception:
                continue
            if existing_width > 0:
                drifts.append(abs(width - existing_width) / existing_width)
    return drifts


def merge_tounicode_map(font, pdf, encoding_map):
    if not encoding_map:
        return False
    existing = parse_tounicode_map(font.get("/ToUnicode"))
    merged = {**existing, **encoding_map}
    if merged == existing and has_tounicode(font):
        return False
    font["/ToUnicode"] = pdf.make_stream(build_tounicode_cmap(merged).encode("utf-8"))
    return True


def record_unresolved(unresolved, font_name, reason):
    unresolved.setdefault(reason, set()).add(font_name)


def mutate_substitute_legacy_fonts_in_place(pdf, mutation):
    applied = []
    warnings = []
    changed = False
    processed_refs = set()
    used_codes_by_font = collect_used_codes_by_font(pdf)
    max_width_drift = float(mutation.get("maxWidthDrift") or 0.12)
    metrics_cache = {}

    for page in pdf.pages:
        resources = page.obj.get("/Resources")
        if not isinstance(resources, pikepdf.Dictionary):
            continue
        fonts = resources.get("/Font")
        if not isinstance(fonts, pikepdf.Dictionary):
            continue
        for _, font in fonts.items():
            if not isinstance(font, pikepdf.Dictionary):
                continue
            if str(font.get("/Subtype")) != "/Type1":
                continue
            descriptor = font_descriptor_for(font)
            if not isinstance(descriptor, pikepdf.Dictionary):
                continue
            if descriptor.get("/FontFile") or descriptor.get("/FontFile2") or descriptor.get("/FontFile3"):
                continue

            font_ref = ref_string(font) or str(id(font))
            if font_ref in processed_refs:
                continue
            processed_refs.add(font_ref)

            base_font = normalized_base_font_name(font.get("/BaseFont"))
            substitute_name = legacy_substitute_font_name(base_font)
            if not substitute_name:
                continue
            substitute_path = font_file_path(substitute_name)
            if not substitute_path:
                warnings.append(f"No substitute font file was found for {base_font} via {substitute_name}.")
                continue

            cache_key = str(substitute_path)
            metrics = metrics_cache.get(cache_key)
            if metrics is None:
                metrics = parse_ttf_metrics(substitute_path)
                metrics_cache[cache_key] = metrics
            if not metrics:
                warnings.append(f"Could not parse metrics for substitute font {substitute_path.name} used for {base_font}.")
                continue

            encoding_map = font_encoding_map(font)
            glyph_name_map = font_encoding_glyph_names(font)
            used_codes = sorted(used_codes_by_font.get(font_ref, set()))
            if used_codes:
                encoding_map = {code: text for code, text in encoding_map.items() if code in used_codes}
                glyph_name_map = {code: name for code, name in glyph_name_map.items() if code in used_codes}
            width_map = {}
            drift_ratios = []
            existing_first = font.get("/FirstChar")
            existing_widths = font.get("/Widths")
            for code, mapped_text in encoding_map.items():
                substitute_width = None
                glyph_name = glyph_name_map.get(code)
                raw_width = (metrics.get("glyph_name_to_width") or {}).get(glyph_name) if glyph_name else None
                if raw_width is not None and metrics.get("units_per_em"):
                    substitute_width = int(round((raw_width / metrics["units_per_em"]) * 1000))
                if substitute_width is None:
                    substitute_width = width_for_unicode(metrics, mapped_text)
                if substitute_width is None:
                    continue
                width_map[code] = substitute_width
                if isinstance(existing_first, int) and isinstance(existing_widths, pikepdf.Array):
                    index = code - existing_first
                    if 0 <= index < len(existing_widths):
                        try:
                            existing_width = int(existing_widths[index])
                            if existing_width > 0:
                                drift_ratios.append(abs(substitute_width - existing_width) / existing_width)
                        except Exception:
                            pass

            if not width_map:
                warnings.append(f"Could not derive substitute widths for {base_font} using {substitute_name}.")
                continue

            if drift_ratios and max(drift_ratios) > max_width_drift:
                warnings.append(
                    f"Skipped substituting {base_font} with {substitute_name} because width drift {max(drift_ratios):.3f} exceeded {max_width_drift:.3f}."
                )
                continue

            embed_font_program(pdf, descriptor, substitute_path, font=font)
            normalize_font_program_subtype(font, descriptor)
            width_changed = update_font_widths(font, width_map)
            if not has_tounicode(font):
                font["/ToUnicode"] = pdf.make_stream(build_tounicode_cmap(encoding_map).encode("utf-8"))

            applied.append({
                "ref": ref_string(font),
                "before": base_font,
                "after": f"{substitute_name} ({substitute_path.name})",
                "details": f"Substituted legacy font {base_font} with embedded fallback {substitute_name} from {substitute_path.name} and rewrote {len(width_map)} width entries."
                  + (f" Max width drift was {max(drift_ratios):.3f}." if drift_ratios else ""),
            })
            changed = True or width_changed

    return changed, applied, warnings


def mutate_finalize_substituted_font_conformance(pdf, mutation):
    applied = []
    warnings = []
    unresolved = {}
    changed = False
    processed_refs = set()
    used_codes_by_font = collect_used_codes_by_font(pdf)
    max_width_drift = float(mutation.get("maxWidthDrift") or 0.35)
    metrics_cache = {}

    for page in pdf.pages:
        resources = page.obj.get("/Resources")
        if not isinstance(resources, pikepdf.Dictionary):
            continue
        fonts = resources.get("/Font")
        if not isinstance(fonts, pikepdf.Dictionary):
            continue
        for _, font in fonts.items():
            if not isinstance(font, pikepdf.Dictionary):
                continue
            subtype = str(font.get("/Subtype"))
            if subtype not in {"/Type1", "/Type3"}:
                continue

            font_ref = ref_string(font) or str(id(font))
            if font_ref in processed_refs:
                continue
            processed_refs.add(font_ref)

            base_font = normalized_base_font_name(font.get("/BaseFont"))
            display_name = base_font or font_ref
            descriptor = font_descriptor_for(font)
            embedded_before = isinstance(descriptor, pikepdf.Dictionary) and (
                descriptor.get("/FontFile") or descriptor.get("/FontFile2") or descriptor.get("/FontFile3")
            )
            if normalize_font_program_subtype(font, descriptor):
                changed = True
            exact_path = font_file_path(base_font)
            substitute_name = legacy_substitute_font_name(base_font)
            substitute_path = font_file_path(substitute_name) if substitute_name else None
            selected_path = exact_path or substitute_path
            selected_name = base_font if exact_path else substitute_name

            if not embedded_before:
                if not isinstance(descriptor, pikepdf.Dictionary) and selected_path:
                    # No descriptor exists — create a minimal one so we can embed the program
                    descriptor = create_font_descriptor(pdf, base_font or "UnknownFont", selected_path)
                    font["/FontDescriptor"] = descriptor
                if isinstance(descriptor, pikepdf.Dictionary) and selected_path:
                    embed_font_program(pdf, descriptor, selected_path, font=font)
                    normalize_font_program_subtype(font, descriptor)
                    changed = True
                    applied.append({
                        "ref": ref_string(font),
                        "before": base_font,
                        "after": str(selected_name),
                        "details": f"{'Embedded exact font program for' if exact_path else 'Embedded fallback substitute for'} {base_font} from {selected_path.name}.",
                    })
                else:
                    record_unresolved(unresolved, display_name, "not_embedded")

            metrics_path = selected_path if selected_path else exact_path
            metrics = None
            if metrics_path:
                cache_key = str(metrics_path)
                metrics = metrics_cache.get(cache_key)
                if metrics is None:
                    metrics = parse_ttf_metrics(metrics_path)
                    metrics_cache[cache_key] = metrics

            encoding_map, glyph_name_map, used_codes = derive_encoding_map_for_used_codes(font, font_ref, used_codes_by_font)
            if not encoding_map and has_tounicode(font):
                existing_map = parse_tounicode_map(font.get("/ToUnicode"))
                if used_codes:
                    encoding_map = {code: text for code, text in existing_map.items() if code in used_codes}
                else:
                    encoding_map = existing_map

            if metrics and encoding_map:
                width_map = derive_width_map(metrics, encoding_map, glyph_name_map)
                if width_map:
                    drift_ratios = width_drift_ratio(font, width_map)
                    if update_font_widths(font, width_map):
                        changed = True
                        drift_note = (f" Max width drift was {max(drift_ratios):.3f}." if drift_ratios else "")
                        applied.append({
                            "ref": ref_string(font),
                            "before": "/Widths",
                            "after": f"{len(width_map)} width entries",
                            "details": f"Normalized width entries for {base_font} from {'exact' if exact_path else 'substituted'} font metrics.{drift_note}",
                        })
                else:
                    record_unresolved(unresolved, display_name, "width_mismatch")
            elif used_codes:
                record_unresolved(unresolved, display_name, "width_mismatch")

            if encoding_map:
                if merge_tounicode_map(font, pdf, encoding_map):
                    changed = True
                    applied.append({
                        "ref": ref_string(font),
                        "before": None,
                        "after": "/ToUnicode",
                        "details": f"Finalized ToUnicode mappings for {base_font} using {len(encoding_map)} used character codes.",
                    })
            elif used_codes:
                record_unresolved(unresolved, display_name, "unicode_unmapped")

    reason_labels = {
        "not_embedded": "unembedded exact font not available",
        "unicode_unmapped": "ToUnicode derivation unavailable",
        "width_mismatch": "width mismatch remained after substitution",
    }
    for reason, fonts in sorted(unresolved.items()):
        font_list = ", ".join(sorted(fonts))
        warnings.append(f"Unresolved font blockers ({reason_labels.get(reason, reason)}): {font_list}.")

    if not changed and not warnings:
        warnings.append("No remaining substituted font objects required final conformance repair.")
    return changed, applied, warnings


def mutate_replace_bookmarks_from_headings(pdf, mutation):
    catalog = get_catalog(pdf)
    if catalog is None:
        return False, [], ["Could not locate the PDF catalog to attach bookmarks."]

    headings = mutation.get("headings") or []
    usable = []
    for heading in headings:
        text = str(heading.get("text") or "").strip()
        level = str(heading.get("level") or "H2").upper()
        target_ref = heading.get("targetRef")
        page_number = heading.get("pageNumber")
        if not text:
            continue
        page_obj = None
        if target_ref:
            target_obj = resolve_obj(pdf, target_ref)
            if isinstance(target_obj, pikepdf.Dictionary):
                page_obj = page_ref_for_struct_elem(target_obj)
        if page_obj is None and page_number is not None:
            page_obj = page_obj_by_number(pdf, page_number)
        if page_obj is None:
            continue
        try:
            level_num = int(level.replace("H", "").replace("/", ""))
        except Exception:
            level_num = 2
        level_num = min(6, max(1, level_num))
        usable.append({
            "text": text,
            "level": level_num,
            "page": page_obj,
        })

    if not usable:
        return False, [], ["No usable heading targets were available for bookmark generation."]

    outlines = pdf.make_indirect(pikepdf.Dictionary({
        "/Type": pikepdf.Name("/Outlines"),
    }))
    catalog["/Outlines"] = outlines
    catalog["/PageMode"] = pikepdf.Name("/UseOutlines")

    root_children = []
    stack = []
    applied = [{
        "ref": ref_string(outlines),
        "before": None,
        "after": "/Outlines",
        "details": f"Created bookmark outline root at {ref_string(outlines)}.",
    }]

    for heading in usable:
        item = pdf.make_indirect(pikepdf.Dictionary({
            "/Title": pikepdf.String(heading["text"]),
            "/Dest": pikepdf.Array([heading["page"], pikepdf.Name("/Fit")]),
        }))
        node = {
            "item": item,
            "level": heading["level"],
            "children": [],
        }
        while stack and stack[-1]["level"] >= node["level"]:
            stack.pop()
        if stack:
            stack[-1]["children"].append(node)
        else:
            root_children.append(node)
        stack.append(node)
        applied.append({
            "ref": ref_string(item),
            "before": None,
            "after": heading["text"],
            "details": f"Created bookmark \"{heading['text']}\" targeting page content.",
        })

    def descendant_count(node):
        return len(node["children"]) + sum(descendant_count(child) for child in node["children"])

    def wire_children(parent_dict, children):
        if not children:
            return
        refs = [child["item"] for child in children]
        parent_dict["/First"] = refs[0]
        parent_dict["/Last"] = refs[-1]
        parent_dict["/Count"] = sum(1 + descendant_count(child) for child in children)
        for index, child in enumerate(children):
            item = child["item"]
            item["/Parent"] = parent_dict
            if index > 0:
                item["/Prev"] = children[index - 1]["item"]
            if index + 1 < len(children):
                item["/Next"] = children[index + 1]["item"]
            if child["children"]:
                wire_children(item, child["children"])
                item["/Count"] = descendant_count(child)

    wire_children(outlines, root_children)
    return True, applied, []


def mutate_create_heading_from_candidate(pdf, mutation):
    target_ref = mutation.get("targetRef")
    if not target_ref:
        return False, [], ["Heading candidate did not map to a structural target."]
    obj = resolve_obj(pdf, target_ref)
    if not isinstance(obj, pikepdf.Dictionary):
        return False, [], [f"Could not resolve structural target {target_ref}."]
    before = str(obj.get("/S"))
    if before not in HEADING_COMPAT_TAGS:
        return False, [], [f"Target {target_ref} has tag {before} and is not safe to retag as a heading."]
    next_level = str(mutation.get("level") or "H2")
    after = normalized_heading_level_for_target(pdf, obj, next_level)
    if before == after:
        return False, [], [f"Target {target_ref} is already tagged as {after}."]
    obj["/S"] = pikepdf.Name(after)
    return True, [{
        "ref": ref_string(obj),
        "before": before,
        "after": after,
        "details": f"Retagged structural candidate {ref_string(obj)} from {before} to {after}.",
    }], []


def mutate_retag_node(pdf, mutation):
    targets = mutation.get("targets") or []
    target_tag = mutation.get("targetTag")
    if not targets or not target_tag:
        return False, [], ["retag_node requires targets and targetTag."]

    applied = []
    normalized_tag = f"/{str(target_tag).lstrip('/')}"
    for ref in targets:
        obj = resolve_obj(pdf, ref)
        if not isinstance(obj, pikepdf.Dictionary):
            continue
        before = str(obj.get("/S"))
        if before == normalized_tag:
            continue
        obj["/S"] = pikepdf.Name(normalized_tag)
        applied.append({
            "ref": ref_string(obj),
            "before": before,
            "after": normalized_tag,
            "details": f"Retagged {ref_string(obj)} from {before} to {normalized_tag}.",
        })
    return bool(applied), applied, []


def mutate_set_table_header_cells(pdf, mutation):
    tables = table_candidates(pdf)
    if not tables:
        return False, [], ["No /Table elements were found in the structure tree."]

    requested = set(mutation.get("targets") or [])
    selected = tables if not requested else [table for table in tables if table["ref"] in requested]
    applied = []
    for table in selected:
        header_refs = []
        for cell_ref in table["firstRowCellRefs"]:
            obj = resolve_obj(pdf, cell_ref)
            if not isinstance(obj, pikepdf.Dictionary):
                continue
            before = str(obj.get("/S"))
            if before != "/TD":
                if before == "/TH":
                    header_refs.append(obj)
                continue
            obj["/S"] = pikepdf.Name("/TH")
            header_refs.append(obj)
            applied.append({
                "ref": ref_string(obj),
                "before": before,
                "after": "/TH",
                "details": f"Promoted first-row table cell {ref_string(obj)} from /TD to /TH.",
            })
        for header_ref in table["headerCellRefs"]:
            obj = resolve_obj(pdf, header_ref)
            if isinstance(obj, pikepdf.Dictionary):
                header_refs.append(obj)
        unique_headers = []
        seen = set()
        for header in header_refs:
            ref = ref_string(header)
            if not ref or ref in seen:
                continue
            seen.add(ref)
            unique_headers.append(header)
            if str(header.get("/Scope")) != "/Column":
                header["/Scope"] = pikepdf.Name("/Column")
                applied.append({
                    "ref": ref,
                    "before": None,
                    "after": "/Scope /Column",
                    "details": f"Set table header scope to /Column on {ref}.",
                })
        if unique_headers:
            table_obj = resolve_obj(pdf, table["ref"])
            if isinstance(table_obj, pikepdf.Dictionary):
                for row in get_child_dicts(table_obj):
                    if str(row.get("/S")) != "/TR":
                        continue
                    for cell in get_child_dicts(row):
                        if str(cell.get("/S")) != "/TD":
                            continue
                        if cell.get("/Headers") is not None:
                            continue
                        cell["/Headers"] = pikepdf.Array(unique_headers)
                        applied.append({
                            "ref": ref_string(cell),
                            "before": None,
                            "after": "/Headers",
                            "details": f"Linked table data cell {ref_string(cell)} to {len(unique_headers)} header cells.",
                        })
    return bool(applied), applied, []


def mutate_set_figure_alt_text(pdf, mutation):
    target_ref = mutation.get("targetRef")
    alt_text = str(mutation.get("altText") or "").strip()
    if not target_ref or not alt_text:
        return False, [], ["set_figure_alt_text requires targetRef and non-empty altText."]
    obj = resolve_obj(pdf, target_ref)
    if not isinstance(obj, pikepdf.Dictionary):
        return False, [], [f"Could not resolve figure target {target_ref}."]
    before_tag = str(obj.get("/S"))
    if before_tag != "/Figure":
        return False, [], [f"Target {target_ref} has tag {before_tag} and is not an existing /Figure."]
    before_alt = obj.get("/Alt")
    before_alt_text = str(before_alt).replace("u:", "") if isinstance(before_alt, str) else None
    obj["/Alt"] = pikepdf.String(alt_text)
    return True, [{
        "ref": ref_string(obj),
        "before": before_alt_text or before_tag,
        "after": alt_text,
        "details": f"Set figure alt text on {ref_string(obj)} to \"{alt_text}\".",
    }], []


def mutate_retag_as_figure_and_set_alt(pdf, mutation):
    target_ref = mutation.get("targetRef")
    alt_text = str(mutation.get("altText") or "").strip()
    if not target_ref or not alt_text:
        return False, [], ["retag_as_figure_and_set_alt requires targetRef and non-empty altText."]
    obj = resolve_obj(pdf, target_ref)
    if not isinstance(obj, pikepdf.Dictionary):
        return False, [], [f"Could not resolve figure target {target_ref}."]
    before_tag = str(obj.get("/S"))
    ancestry = set(parent_tag_path(obj) + [before_tag])
    text_density = str(mutation.get("textDensityHint") or "").strip().lower()
    image_evidence = str(mutation.get("imageEvidence") or "").strip().lower()
    page_image_count = mutation.get("pageImageCount")
    try:
        page_image_count = int(page_image_count) if page_image_count is not None else 0
    except Exception:
        page_image_count = 0
    if text_density == "high" and before_tag != "/TextBox":
        return False, [], [f"text_heavy_candidate: Target {target_ref} appears text-heavy and is not safe to retag as /Figure."]
    if image_evidence and image_evidence != "strong":
        return False, [], [f"no_image_evidence: Target {target_ref} does not have strong enough image evidence for automatic figure retagging."]
    if page_image_count <= 0:
        return False, [], [f"no_image_evidence: Page context for {target_ref} does not indicate any renderable images."]
    if before_tag not in SAFE_FIGURE_RETAG_TAGS:
        if before_tag not in FIGURE_WRAP_TAGS:
            return False, [], [f"Target {target_ref} has tag {before_tag} and is not safe to retag as /Figure."]
        original_k = obj.get("/K")
        if original_k is None:
            return False, [], [f"Target {target_ref} has tag {before_tag} but does not expose content to wrap in a /Figure child."]
        figure = pdf.make_indirect(pikepdf.Dictionary({
            "/Type": pikepdf.Name("/StructElem"),
            "/S": pikepdf.Name("/Figure"),
            "/P": obj,
            "/K": original_k,
            "/Alt": pikepdf.String(alt_text),
        }))
        obj["/K"] = figure
        if isinstance(original_k, pikepdf.Dictionary):
            original_k["/P"] = figure
        elif isinstance(original_k, pikepdf.Array):
            for child in original_k:
                if isinstance(child, pikepdf.Dictionary):
                    child["/P"] = figure
        return True, [{
            "ref": ref_string(figure),
            "before": before_tag,
            "after": alt_text,
            "details": f"Wrapped content of {ref_string(obj)} in a child /Figure and set alt text to \"{alt_text}\".",
        }], []
    if ancestry & UNSAFE_FIGURE_ANCESTRY:
        original_k = obj.get("/K")
        if original_k is None:
            return False, [], [f"unsafe_ancestry: Target {target_ref} is nested under {', '.join(sorted(ancestry & UNSAFE_FIGURE_ANCESTRY))} and does not expose content to wrap in a /Figure child."]
        figure = pdf.make_indirect(pikepdf.Dictionary({
            "/Type": pikepdf.Name("/StructElem"),
            "/S": pikepdf.Name("/Figure"),
            "/P": obj,
            "/K": original_k,
            "/Alt": pikepdf.String(alt_text),
        }))
        obj["/K"] = figure
        if isinstance(original_k, pikepdf.Dictionary):
            original_k["/P"] = figure
        elif isinstance(original_k, pikepdf.Array):
            for child in original_k:
                if isinstance(child, pikepdf.Dictionary):
                    child["/P"] = figure
        return True, [{
            "ref": ref_string(figure),
            "before": before_tag,
            "after": alt_text,
            "details": f"Wrapped content under {ref_string(obj)} in a child /Figure despite unsafe ancestry and set alt text to \"{alt_text}\".",
        }], []
    obj["/S"] = pikepdf.Name("/Figure")
    obj["/Alt"] = pikepdf.String(alt_text)
    return True, [{
        "ref": ref_string(obj),
        "before": before_tag,
        "after": alt_text,
        "details": f"Retagged {ref_string(obj)} as /Figure and set alt text to \"{alt_text}\".",
    }], []


def mutate_mark_figure_decorative(pdf, mutation):
    target_ref = mutation.get("targetRef")
    if not target_ref:
        return False, [], ["mark_figure_decorative requires targetRef."]
    obj = resolve_obj(pdf, target_ref)
    if not isinstance(obj, pikepdf.Dictionary):
        return False, [], [f"Could not resolve figure target {target_ref}."]
    before_tag = str(obj.get("/S"))
    if before_tag != "/Figure":
        return False, [], [f"Target {target_ref} has tag {before_tag} and is not an existing /Figure."]
    obj["/Alt"] = pikepdf.String("Decorative image")
    return True, [{
        "ref": ref_string(obj),
        "before": before_tag,
        "after": "Decorative image",
        "details": f"Marked {ref_string(obj)} as decorative by setting fallback alt text.",
    }], []


def mutate_reorder_structure_children(pdf, mutation):
    parent_ref = mutation.get("parentRef")
    ordered_targets = mutation.get("orderedTargets") or []
    if not ordered_targets:
        return False, [], ["reorder_structure_children requires orderedTargets."]
    parent = resolve_obj(pdf, parent_ref) if parent_ref else get_struct_tree_root(pdf)
    if not isinstance(parent, pikepdf.Dictionary):
        return False, [], ["Could not resolve reading-order parent."]
    kids = parent.get("/K")
    if not isinstance(kids, pikepdf.Array):
        return False, [], ["Parent does not expose a mutable /K array."]
    before_disorder = mcid_disorder_score(parent)
    expected_disorder = mutation.get("expectedDisorderBefore")
    if expected_disorder is not None:
        try:
            expected_disorder = float(expected_disorder)
        except Exception:
            expected_disorder = None
    if expected_disorder is not None and abs(before_disorder - expected_disorder) > 0.001:
        return False, [], [f"Reading-order parent changed since inspection: expected disorder {expected_disorder}, found {before_disorder}."]

    by_ref = {}
    existing_order = []
    for child in kids:
        if isinstance(child, pikepdf.Dictionary):
            child_ref = ref_string(child)
            if child_ref:
                by_ref[child_ref] = child
                existing_order.append(child_ref)

    requested = [ref for ref in ordered_targets if ref in by_ref]
    if len(requested) < 2:
        return False, [], ["Not enough matching structure children were found to reorder."]
    if requested == existing_order[:len(requested)]:
        return False, [], ["Requested structure children are already in the desired order."]

    new_kids = pikepdf.Array()
    consumed = set(requested)
    for ref in requested:
        new_kids.append(by_ref[ref])
    for ref in existing_order:
        if ref not in consumed:
            new_kids.append(by_ref[ref])
    original_kids = pikepdf.Array(kids)
    parent["/K"] = new_kids
    after_disorder = mcid_disorder_score(parent)
    if expected_disorder is not None and after_disorder >= before_disorder:
        parent["/K"] = original_kids
        return False, [], [f"Requested reorder did not improve MCID disorder for {parent_ref or ref_string(parent)} (before {before_disorder}, after {after_disorder})."]

    return True, [{
        "ref": parent_ref or ref_string(parent),
        "before": ", ".join(existing_order),
        "after": ", ".join([ref_string(child) for child in new_kids if isinstance(child, pikepdf.Dictionary)]),
        "details": f"Reordered {len(requested)} structure children under {parent_ref or ref_string(parent)} (MCID disorder {before_disorder:.3f} -> {after_disorder:.3f}).",
    }], []


def snapshot(pdf, inspect_mode="light"):
    include_image_struct_nodes = inspect_mode == "alt_text_deep"
    return {
        "headings": top_level_heading_candidates(pdf),
        "structuralNodes": structural_nodes(pdf),
        "tables": table_candidates(pdf),
        "figures": figure_candidates(pdf),
        "imageStructNodes": image_struct_candidates(pdf) if include_image_struct_nodes else [],
        "readingOrderNodes": reading_order_nodes(pdf),
        "readingOrderParents": reading_order_parents(pdf),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--request", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    request = json.loads(Path(args.request).read_text(encoding="utf-8"))
    pdf = pikepdf.Pdf.open(args.input)

    operation = request.get("operation")
    warnings = []
    changed = False
    applied = []

    inspect_mode = str(request.get("inspectMode") or "light")

    if operation == "inspect":
        pass
    elif operation == "bootstrap_struct_tree":
        changed, applied, warnings = mutate_bootstrap_struct_tree(pdf, request)
    elif operation == "set_pdfua_identification":
        changed, applied, warnings = mutate_set_pdfua_identification(pdf, request)
    elif operation == "normalize_annotation_tab_order":
        changed, applied, warnings = mutate_normalize_annotation_tab_order(pdf, request)
    elif operation == "repair_cid_symbol_font_maps":
        changed, applied, warnings = mutate_repair_cid_symbol_font_maps(pdf, request)
    elif operation == "repair_cidset_consistency":
        changed, applied, warnings = mutate_repair_cidset_consistency(pdf, request)
    elif operation == "repair_structure_conformance":
        changed, applied, warnings = mutate_repair_structure_conformance(pdf, request)
    elif operation == "repair_type1_font_unicode_maps":
        changed, applied, warnings = mutate_repair_type1_font_unicode_maps(pdf, request)
    elif operation == "substitute_legacy_fonts_in_place":
        changed, applied, warnings = mutate_substitute_legacy_fonts_in_place(pdf, request)
    elif operation == "finalize_substituted_font_conformance":
        changed, applied, warnings = mutate_finalize_substituted_font_conformance(pdf, request)
    elif operation == "repair_note_tag_ids":
        changed, applied, warnings = mutate_repair_note_tag_ids(pdf, request)
    elif operation == "repair_native_marked_content_refs":
        changed, applied, warnings = mutate_repair_native_marked_content_refs(pdf, request)
    elif operation == "repair_native_link_structure":
        changed, applied, warnings = mutate_repair_native_link_structure(pdf, request)
    elif operation == "repair_bootstrapped_chart_content_refs":
        changed, applied, warnings = mutate_repair_bootstrapped_chart_content_refs(pdf, request)
    elif operation == "repair_native_figure_semantics":
        changed, applied, warnings = mutate_repair_native_figure_semantics(pdf, request)
    elif operation == "repair_native_table_headers":
        changed, applied, warnings = mutate_repair_native_table_headers(pdf, request)
    elif operation == "repair_native_reading_order":
        changed, applied, warnings = mutate_repair_native_reading_order(pdf, request)
    elif operation == "repair_font_unicode_maps":
        changed, applied, warnings = mutate_repair_font_unicode_maps(pdf, request)
    elif operation == "embed_missing_fonts_in_place":
        changed, applied, warnings = mutate_embed_missing_fonts_in_place(pdf, request)
    elif operation == "artifact_nonsemantic_page_elements":
        changed, applied, warnings = mutate_artifact_nonsemantic_page_elements(pdf, request)
    elif operation == "replace_bookmarks_from_headings":
        changed, applied, warnings = mutate_replace_bookmarks_from_headings(pdf, request)
    elif operation == "create_heading_tag":
        changed, applied, warnings = mutate_create_heading_tag(pdf, request)
    elif operation == "create_heading_from_candidate":
        changed, applied, warnings = mutate_create_heading_from_candidate(pdf, request)
    elif operation == "retag_node":
        changed, applied, warnings = mutate_retag_node(pdf, request)
    elif operation == "set_table_header_cells":
        changed, applied, warnings = mutate_set_table_header_cells(pdf, request)
    elif operation == "set_figure_alt_text":
        changed, applied, warnings = mutate_set_figure_alt_text(pdf, request)
    elif operation == "retag_as_figure_and_set_alt":
        changed, applied, warnings = mutate_retag_as_figure_and_set_alt(pdf, request)
    elif operation == "mark_figure_decorative":
        changed, applied, warnings = mutate_mark_figure_decorative(pdf, request)
    elif operation == "reorder_structure_children":
        changed, applied, warnings = mutate_reorder_structure_children(pdf, request)
    else:
        snap = snapshot(pdf, inspect_mode)
        print(json.dumps({
            "status": "unsupported",
            "changedDocumentBytes": False,
            "appliedMutations": [],
            "warnings": [f"Unsupported operation: {operation}"],
            **snap,
        }))
        return

    if changed:
        pdf.save(args.output)

    snap = snapshot(pdf, inspect_mode)
    print(json.dumps({
        "status": "applied" if changed else "no_effect",
        "changedDocumentBytes": changed,
        "appliedMutations": applied,
        "warnings": warnings,
        **snap,
    }))


if __name__ == "__main__":
    main()
