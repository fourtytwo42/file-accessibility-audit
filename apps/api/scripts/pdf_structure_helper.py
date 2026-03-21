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


HEADING_COMPAT_TAGS = {"/P", "/Span", "/Div", "/NonStruct", "/TextBox", "/Sect", "/Story", "/Normal", "/H", "/H1", "/H2", "/H3", "/H4", "/H5", "/H6"}
FIGURE_COMPAT_TAGS = {"/Figure", "/P", "/Span", "/Div", "/NonStruct", "/Shape", "/InlineShape", "/Normal"}
SAFE_FIGURE_RETAG_TAGS = {"/P", "/Span", "/Div", "/NonStruct", "/TextBox", "/Shape", "/InlineShape", "/Normal"}
UNSAFE_FIGURE_ANCESTRY = {"/Table", "/TR", "/TH", "/TD", "/TOC", "/TOCI", "/Link", "/L", "/LI"}
FIGURE_WRAP_TAGS = {"/LI", "/TH", "/TD", "/P", "/Span", "/Div", "/NonStruct", "/TextBox", "/Story"}
LEGACY_HEADING_TAG_RE = re.compile(r"^/heading\s+(\d+)$", re.IGNORECASE)


def is_heading_compat_tag(tag):
    normalized = str(tag or "")
    return normalized in HEADING_COMPAT_TAGS or LEGACY_HEADING_TAG_RE.fullmatch(normalized) is not None
EMBEDDABLE_FONT_FILES = {
    # Arial family
    "/Arial": "arial.ttf",
    "/Arial,Bold": "arialbd.ttf",
    "/Arial,Italic": "ariali.ttf",
    "/Arial,BoldItalic": "arialbi.ttf",
    "/ArialMT": "arial.ttf",
    "/Arial-BoldMT": "arialbd.ttf",
    "/Arial-ItalicMT": "ariali.ttf",
    "/Arial-BoldItalicMT": "arialbi.ttf",
    # Arial Narrow — Liberation Sans Narrow is metric-compatible
    "/ArialNarrow": "LiberationSansNarrow-Regular.ttf",
    "/ArialNarrow-Bold": "LiberationSansNarrow-Bold.ttf",
    "/ArialNarrow-Italic": "LiberationSansNarrow-Italic.ttf",
    "/ArialNarrow-BoldItalic": "LiberationSansNarrow-BoldItalic.ttf",
    # Segoe UI — Noto Sans is the closest open-source substitute
    "/SegoeUI-Regular": "NotoSans-Regular.ttf",
    "/SegoeUI-Bold": "NotoSans-Bold.ttf",
    "/SegoeUI-Italic": "NotoSans-Italic.ttf",
    "/SegoeUI-Light": "NotoSans-Regular.ttf",
    # Georgia — Noto Serif (humanist serif, similar proportions)
    "/Georgia-Regular": "NotoSerif-Regular.ttf",
    "/Georgia-Bold": "NotoSerif-Bold.ttf",
    "/Georgia-Italic": "NotoSerif-Italic.ttf",
    "/Georgia-BoldItalic": "NotoSerif-BoldItalic.ttf",
    # Baskerville variants → Noto Serif
    "/BaskervilleOldFace": "NotoSerif-Regular.ttf",
    "/LibreBaskerville-Regular": "NotoSerif-Regular.ttf",
    "/LibreBaskerville-Italic": "NotoSerif-Italic.ttf",
    "/LibreBaskerville-Bold": "NotoSerif-Bold.ttf",
    # Calibri (Carlito is metric-compatible)
    "/Calibri": "calibri.ttf",
    "/Calibri-Bold": "calibrib.ttf",
    "/Calibri-Italic": "calibri.ttf",
    "/Calibri-BoldItalic": "calibrib.ttf",
    # Times New Roman
    "/TimesNewRoman": "times.ttf",
    "/TimesNewRoman,Bold": "timesbd.ttf",
    "/TimesNewRoman,Italic": "timesi.ttf",
    "/TimesNewRoman,BoldItalic": "timesbi.ttf",
    "/TimesNewRomanPSMT": "times.ttf",
    "/TimesNewRomanPS-BoldMT": "timesbd.ttf",
    "/TimesNewRomanPS-ItalicMT": "timesi.ttf",
    "/TimesNewRomanPS-BoldItalicMT": "timesbi.ttf",
    # Helvetica → Arial (traditional substitute)
    "/Helvetica": "arial.ttf",
    "/Helvetica-Bold": "arialbd.ttf",
    "/Helvetica-Oblique": "ariali.ttf",
    "/Helvetica-BoldOblique": "arialbi.ttf",
    "/HelveticaNeue": "arial.ttf",
    "/HelveticaNeue-Bold": "arialbd.ttf",
    "/HelveticaNeue-Italic": "ariali.ttf",
    "/HelveticaNeue-BoldItalic": "arialbi.ttf",
    # Verdana
    "/Verdana": "verdana.ttf",
    "/Verdana-Bold": "verdanab.ttf",
    "/Verdana-Italic": "verdana.ttf",
    "/Verdana-BoldItalic": "verdanab.ttf",
    # Source Sans 3 → IBM Plex Sans (both geometric sans-serifs)
    "/SourceSans3-Regular": "IBMPlexSans-Regular.ttf",
    "/SourceSans3-It": "IBMPlexSans-Italic.ttf",
    "/SourceSans3-Italic": "IBMPlexSans-Italic.ttf",
    "/SourceSans3-Bold": "IBMPlexSans-Bold.ttf",
    "/SourceSans3-Black": "IBMPlexSans-Bold.ttf",
    "/SourceSans3-Light": "IBMPlexSans-Light.ttf",
    # IBM Plex Sans (TTF versions)
    "/IBMPlexSans-Regular": "IBMPlexSans-Regular.ttf",
    "/IBMPlexSans-Italic": "IBMPlexSans-Italic.ttf",
    "/IBMPlexSans-Bold": "IBMPlexSans-Bold.ttf",
    "/IBMPlexSans-Light": "IBMPlexSans-Light.ttf",
    # Libertinus → Noto equivalents
    "/LibertinusSans-Regular": "NotoSans-Regular.ttf",
    "/LibertinusSans-Bold": "NotoSans-Bold.ttf",
    "/LibertinusSans-Italic": "NotoSans-Italic.ttf",
    "/LibertinusSerif-Regular": "NotoSerif-Regular.ttf",
    "/LibertinusSerif-Italic": "NotoSerif-Italic.ttf",
    "/LibertinusSerif-Bold": "NotoSerif-Bold.ttf",
    "/LibertinusSerif-BoldItalic": "NotoSerif-BoldItalic.ttf",
    # Open Sans
    "/OpenSans-Regular": "OpenSans-Regular.ttf",
    "/OpenSans-Bold": "OpenSans-Bold.ttf",
    "/OpenSans-Italic": "OpenSans-Italic.ttf",
    # Palatino / Book Antiqua → Noto Serif (transitional serif)
    "/Palatino-Roman": "NotoSerif-Regular.ttf",
    "/Palatino-Bold": "NotoSerif-Bold.ttf",
    "/Palatino-Italic": "NotoSerif-Italic.ttf",
    "/Palatino-BoldItalic": "NotoSerif-BoldItalic.ttf",
    "/BookAntiqua": "NotoSerif-Regular.ttf",
    "/BookAntiqua-Bold": "NotoSerif-Bold.ttf",
    "/BookAntiqua-Italic": "NotoSerif-Italic.ttf",
    "/BookAntiqua-BoldItalic": "NotoSerif-BoldItalic.ttf",
    # Garamond → Noto Serif
    "/Garamond": "NotoSerif-Regular.ttf",
    "/Garamond-Bold": "NotoSerif-Bold.ttf",
    "/Garamond-Italic": "NotoSerif-Italic.ttf",
    # Century Schoolbook, Century Gothic → Arial / Times
    "/CenturySchoolbook": "times.ttf",
    "/CenturyGothic": "arial.ttf",
    "/CenturyGothic-Bold": "arialbd.ttf",
    # Tahoma → Noto Sans
    "/Tahoma": "NotoSans-Regular.ttf",
    "/Tahoma-Bold": "NotoSans-Bold.ttf",
    # Symbol-oriented Unicode fonts
    "/NotoSansSymbols-Regular": "NotoSansSymbols-Regular.ttf",
    "/NotoSansSymbols2-Regular": "NotoSansSymbols2-Regular.ttf",
    # Standard PDF Type1 fonts — embed substitutes so veraPDF's containsFontFile check passes
    "/Times-Roman": "times.ttf",
    "/Times-Bold": "timesbd.ttf",
    "/Times-Italic": "timesi.ttf",
    "/Times-BoldItalic": "timesbi.ttf",
    "/Symbol": "IBMPlexSans-Regular.ttf",
    "/ZapfDingbats": "IBMPlexSans-Regular.ttf",
    "/Courier": "LiberationMono-Regular.ttf",
    "/Courier-Bold": "LiberationMono-Bold.ttf",
    "/Courier-Oblique": "LiberationMono-Italic.ttf",
    "/Courier-BoldOblique": "LiberationMono-BoldItalic.ttf",
    # Courier New
    "/CourierNewPSMT": "LiberationMono-Regular.ttf",
    "/CourierNewPS-BoldMT": "LiberationMono-Bold.ttf",
    "/CourierNewPS-ItalicMT": "LiberationMono-Italic.ttf",
    "/CourierNewPS-BoldItalicMT": "LiberationMono-BoldItalic.ttf",
    "/CourierNew": "LiberationMono-Regular.ttf",
    "/CourierNew-Bold": "LiberationMono-Bold.ttf",
    "/CourierNew-Italic": "LiberationMono-Italic.ttf",
    "/CourierNew-BoldItalic": "LiberationMono-BoldItalic.ttf",
}

LEGACY_FONT_SUBSTITUTES = {
    # Tekton family (display sans → Arial)
    "/Tekton": "/ArialMT",
    "/Tekton-Bold": "/Arial-BoldMT",
    "/Tekton-Italic": "/Arial-ItalicMT",
    "/Tekton-BoldItalic": "/Arial-BoldItalicMT",
    # Gill Sans family (humanist sans → Arial/Segoe-like sans)
    "/GillSans": "/ArialMT",
    "/GillSans-Bold": "/Arial-BoldMT",
    "/GillSans-Italic": "/Arial-ItalicMT",
    "/GillSans-BoldItalic": "/Arial-BoldItalicMT",
    # Optima family (humanist sans → Noto Sans)
    "/Optima": "/SegoeUI-Regular",
    "/Optima-Bold": "/SegoeUI-Bold",
    "/Optima-Italic": "/SegoeUI-Italic",
    "/Optima-BoldItalic": "/SegoeUI-Italic",
    "/Optima-ExtraBlack": "/SegoeUI-Bold",
    # Frutiger family (exact variants first, prefix catch-all last)
    "/Frutiger-Roman": "/SegoeUI-Regular",
    "/Frutiger-Italic": "/SegoeUI-Italic",
    "/Frutiger-Black": "/SegoeUI-Bold",
    "/Frutiger-Light": "/SegoeUI-Light",
    "/Frutiger-Bold": "/SegoeUI-Bold",
    "/Frutiger-BoldItalic": "/SegoeUI-Italic",
    "/Frutiger-LightItalic": "/SegoeUI-Italic",
    "/Frutiger-BlackItalic": "/SegoeUI-Italic",
    "/Frutiger-UltraBlack": "/SegoeUI-Bold",
    "/Frutiger-55Roman": "/SegoeUI-Regular",
    "/Frutiger-56Italic": "/SegoeUI-Italic",
    "/Frutiger-45Light": "/SegoeUI-Light",
    "/Frutiger-46LightItalic": "/SegoeUI-Italic",
    "/Frutiger-65Bold": "/SegoeUI-Bold",
    "/Frutiger-66BoldItalic": "/SegoeUI-Italic",
    "/Frutiger-75Black": "/SegoeUI-Bold",
    "/Frutiger-76BlackItalic": "/SegoeUI-Italic",
    # AkzidenzGrotesk family (geometric grotesque → IBM Plex Sans)
    "/AkzidenzGroteskBE-Light": "/IBMPlexSans-Light",
    "/AkzidenzGroteskBE-Regular": "/IBMPlexSans-Regular",
    "/AkzidenzGroteskBE-Bold": "/IBMPlexSans-Bold",
    "/AkzidenzGroteskBE-Italic": "/IBMPlexSans-Italic",
    "/AkzidenzGroteskBE-BoldItalic": "/IBMPlexSans-Italic",
    "/AkzidenzGroteskBE-LightItalic": "/IBMPlexSans-Italic",
    "/AkzidenzGroteskBE-MdIt": "/IBMPlexSans-Italic",
    "/AkzidenzGroteskBE-Medium": "/IBMPlexSans-Bold",
    "/AkzidenzGroteskBE-Super": "/IBMPlexSans-Bold",
    # Univers family (neo-grotesque condensed → Arial Narrow)
    "/Univers-Condensed": "/ArialNarrow",
    "/Univers-CondensedBold": "/ArialNarrow-Bold",
    "/Univers-CondensedItalic": "/ArialNarrow-Italic",
    "/Univers-CondensedBoldItalic": "/ArialNarrow-BoldItalic",
    "/Univers-Light": "/SegoeUI-Light",
    "/Univers-Roman": "/SegoeUI-Regular",
    "/Univers-Bold": "/SegoeUI-Bold",
    "/Univers-Italic": "/SegoeUI-Italic",
    # Formata
    "/Formata-Regular": "/SegoeUI-Regular",
    "/Formata-Medium": "/SegoeUI-Bold",
    "/Formata-Italic": "/SegoeUI-Italic",
    # Garamond / AGaramond (old-style serif → Georgia/NotoSerif)
    "/AGaramond-Regular": "/Georgia-Regular",
    "/AGaramond-Italic": "/Georgia-Italic",
    "/AGaramond-Semibold": "/Georgia-Bold",
    "/AGaramond-SemiboldItalic": "/Georgia-BoldItalic",
    "/GaramondMT": "/Georgia-Regular",
    "/GaramondMT-Bold": "/Georgia-Bold",
    "/GaramondMT-Italic": "/Georgia-Italic",
    # New Century Schoolbook / Palatino (transitional serif → Georgia/NotoSerif)
    "/NewCenturySchlbk-Roman": "/Georgia-Regular",
    "/NewCenturySchlbk-Bold": "/Georgia-Bold",
    "/NewCenturySchlbk-Italic": "/Georgia-Italic",
    "/NewCenturySchlbk-BoldItalic": "/Georgia-BoldItalic",
    "/Palatino-Roman": "/Georgia-Regular",
    "/Palatino-Bold": "/Georgia-Bold",
    "/Palatino-Italic": "/Georgia-Italic",
    "/Palatino-BoldItalic": "/Georgia-BoldItalic",
    # Avant Garde / Franklin Gothic / Myriad (geometric/humanist sans → Arial)
    "/AvantGarde-Book": "/ArialMT",
    "/AvantGarde-Demi": "/Arial-BoldMT",
    "/AvantGarde-BookOblique": "/Arial-ItalicMT",
    "/FranklinGothic-Book": "/ArialMT",
    "/FranklinGothic-Demi": "/Arial-BoldMT",
    "/FranklinGothic-Heavy": "/Arial-BoldMT",
    "/FranklinGothicMedium": "/Arial-BoldMT",
    "/MyriadPro-Regular": "/ArialMT",
    "/MyriadPro-Bold": "/Arial-BoldMT",
    "/MyriadPro-It": "/Arial-ItalicMT",
    "/MyriadPro-BoldIt": "/Arial-BoldItalicMT",
    # Minion Pro (old-style serif → Times)
    "/MinionPro-Regular": "/TimesNewRomanPSMT",
    "/MinionPro-Bold": "/TimesNewRomanPS-BoldMT",
    "/MinionPro-It": "/TimesNewRomanPS-ItalicMT",
    "/MinionPro-BoldIt": "/TimesNewRomanPS-BoldItalicMT",
    # Baskerville family (transitional serif → NotoSerif)
    "/BaskervilleBE-Regular": "/Georgia-Regular",
    "/BaskervilleBE-Italic": "/Georgia-Italic",
    "/BaskervilleBE-Bold": "/Georgia-Bold",
    "/BaskervilleBE-Medium": "/Georgia-Bold",
    "/BaskervilleBE-MediumItalic": "/Georgia-Italic",
    "/BaskervilleBE-Light": "/BaskervilleOldFace",
    "/BaskervilleBE-LightItalic": "/Georgia-Italic",
    "/BaskervilleBE-BoldItalic": "/Georgia-BoldItalic",
    "/BaskervilleBE-SmBdIt": "/Georgia-BoldItalic",
    # Boton brochure fonts (display sans → Arial)
    "/Boton": "/ArialMT",
    "/Boton-Regular": "/ArialMT",
    "/Boton-Italic": "/Arial-ItalicMT",
    "/Boton-Bold": "/Arial-BoldMT",
    "/Boton-BoldItalic": "/Arial-BoldItalicMT",
    # Prefix catch-alls — these must come LAST so exact entries above take priority
    "/Frutiger": "/SegoeUI-Regular",
    "/AkzidenzGroteskBE": "/IBMPlexSans-Regular",
    "/AkzidenzGrotesk": "/IBMPlexSans-Regular",
    "/BaskervilleBE": "/Georgia-Regular",
    "/Univers": "/SegoeUI-Regular",
    "/Franklin": "/ArialMT",
    "/Myriad": "/ArialMT",
    "/Minion": "/TimesNewRomanPSMT",
    "/Garamond": "/Georgia-Regular",
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

TYPE1_SUBSET_UNICODE_MAPS = {
    "/MSTT31c5d5": {
        178: "\u2264",
    },
}

SIMPLE_TRUETYPE_UNICODE_MAPS = {
    "/Symbol": {
        0x96: "\u2013",
        0x97: "\u2014",
        0xA3: "\u2264",
        0xB7: "\u2022",
    },
    "/MapInfoArrows": {
        0x3D: "\u2019",
        0x40: "\u2022",
        0x41: "\u2022",
        0x42: "\u2013",
    },
}

SIMPLE_TRUETYPE_ENCODING_DIFFERENCES = {
    "/Symbol": [
        163, pikepdf.Name("/lessequal"),
    ],
    "/MapInfoArrows": [
        61, pikepdf.Name("/quoteright"),
        64, pikepdf.Name("/bullet"),
        pikepdf.Name("/bullet"),
        pikepdf.Name("/endash"),
    ],
}

SIMPLE_TRUETYPE_SUBSTITUTE_FONTS = {
    "/MapInfoArrows": "/ArialMT",
}

HEURISTIC_SUBSET_FALLBACKS = [
    # Serif candidates (best match for body text in older government PDFs)
    "/TimesNewRomanPSMT",
    "/TimesNewRomanPS-BoldMT",
    "/TimesNewRomanPS-ItalicMT",
    "/Georgia-Regular",
    "/Georgia-Bold",
    "/Georgia-Italic",
    # Sans-serif candidates
    "/ArialMT",
    "/Arial-BoldMT",
    "/Arial-ItalicMT",
    "/SegoeUI-Regular",
    "/SegoeUI-Bold",
    "/IBMPlexSans-Regular",
    "/IBMPlexSans-Bold",
    # Narrow sans (for condensed/narrow fonts)
    "/ArialNarrow",
    "/ArialNarrow-Bold",
    # Monospace (for Courier-like fonts)
    "/Courier",
    "/Courier-Bold",
    # Broad coverage fallback
    "/Calibri",
    "/Verdana",
]

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
    if isinstance(kids, pikepdf.Dictionary):
        return [kids]
    return []


def table_row_dicts(table_obj):
    rows = []
    for child in get_child_dicts(table_obj):
        tag = str(child.get("/S"))
        if tag == "/TR":
            rows.append(child)
            continue
        if tag in {"/THead", "/TBody", "/TFoot"}:
            rows.extend([
                row
                for row in get_child_dicts(child)
                if isinstance(row, pikepdf.Dictionary) and str(row.get("/S")) == "/TR"
            ])
    return rows


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
    page_text_cache = {}
    for obj in iter_struct_elems(pdf):
        tag = str(obj.get("/S"))
        parent = obj.get("/P")
        parent_ref = ref_string(parent) if isinstance(parent, pikepdf.Dictionary) else None
        if is_heading_compat_tag(tag) and parent_ref:
            page_obj = obj.get("/Pg")
            page_ref = ref_string(page_obj) if isinstance(page_obj, pikepdf.Dictionary) else None
            text_map = page_text_cache.get(page_ref)
            if text_map is None:
                text_map = page_mcid_text_map(page_obj) if isinstance(page_obj, pikepdf.Dictionary) else {}
                page_text_cache[page_ref] = text_map
            heading_text = " ".join(
                text_map.get(mcid, "").strip()
                for mcid in normalized_struct_elem_mcids(obj)
                if text_map.get(mcid, "").strip()
            ).strip() or None
            candidates.append({
                "ref": ref_string(obj),
                "tag": tag,
                "parentRef": parent_ref,
                "text": heading_text,
            })
    return [candidate for candidate in candidates if candidate["ref"]]


def heading_level_number(tag):
    value = str(tag or "").upper().replace("/", "")
    if re.fullmatch(r"H[1-6]", value):
        return int(value[1:])
    legacy = LEGACY_HEADING_TAG_RE.fullmatch(str(tag or ""))
    if legacy is not None:
        return min(6, max(1, int(legacy.group(1))))
    return None


def normalize_heading_sequence(levels):
    normalized = []
    previous = None
    for index, level in enumerate(levels):
        numeric = heading_level_number(level)
        if numeric is None:
            numeric = 2
        if index == 0:
            numeric = 1
        elif previous is not None:
            if numeric > previous + 1:
                numeric = previous + 1
            elif numeric < previous:
                numeric = previous
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
        row_nodes = table_row_dicts(obj)
        if row_nodes:
            first_row = row_nodes[0]
            for cell in get_child_dicts(first_row):
                if isinstance(cell, pikepdf.Dictionary):
                    ref = ref_string(cell)
                    if ref:
                        first_row_cell_refs.append(ref)
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
    page_usage = {}
    def count_descendant_figures(node):
        count = 0
        visited = set()

        def visit(value, is_root=False):
            nonlocal count
            if not isinstance(value, pikepdf.Dictionary):
                return
            node_ref = ref_string(value)
            if node_ref and node_ref in visited:
                return
            if node_ref:
                visited.add(node_ref)
            if not is_root and str(value.get("/S")) == "/Figure":
                count += 1
            kids = value.get("/K")
            if isinstance(kids, pikepdf.Array):
                for child in kids:
                    visit(child)
            elif isinstance(kids, pikepdf.Dictionary):
                visit(kids)

        visit(node, is_root=True)
        return count

    for obj in iter_struct_elems(pdf):
        tag = str(obj.get("/S"))
        if tag != "/Figure":
            continue
        mcids = normalized_struct_elem_mcids(obj)
        # Skip orphaned Figure elements that have no content association (no MCIDs and no
        # OBJR kids). These empty Figures must NOT receive alt text — Adobe's
        # "Associated with content" check fails for /Figure elements with /Alt but no
        # content backing them. Semantic enrichment must not touch these.
        if not mcids:
            kids = obj.get("/K")
            kid_list = list(kids) if isinstance(kids, pikepdf.Array) else ([kids] if kids is not None else [])
            has_objr = any(
                isinstance(k, pikepdf.Dictionary) and str(k.get("/Type", "")) == "/OBJR"
                for k in kid_list
            )
            has_struct_children = any(
                isinstance(k, pikepdf.Dictionary)
                and str(k.get("/Type", "")) != "/OBJR"
                and str(k.get("/S", "")).startswith("/")
                for k in kid_list
            )
            has_page_backed_child = any(
                isinstance(k, pikepdf.Dictionary) and page_ref_for_struct_elem(k) is not None
                for k in kid_list
            )
            if not has_objr and not (has_struct_children and has_page_backed_child):
                continue
        page_obj = page_ref_for_struct_elem(obj)
        page_ref = ref_string(page_obj) if isinstance(page_obj, pikepdf.Dictionary) else None
        usage = page_usage.setdefault(page_ref, page_mcid_analysis(page_obj)) if page_ref and isinstance(page_obj, pikepdf.Dictionary) else {}
        has_text = any(usage.get(mcid, {}).get("hasText") for mcid in mcids)
        has_graphics = any(usage.get(mcid, {}).get("hasGraphics") for mcid in mcids)
        raw_alt = obj.get("/Alt")
        alt_text = str(raw_alt).replace("u:", "") if raw_alt is not None else None
        split_generated = False
        split_source_ref = None
        split_source_tag = None
        parent = obj.get("/P")
        if isinstance(parent, pikepdf.Dictionary):
            kids = parent.get("/K")
            kid_list = list(kids) if isinstance(kids, pikepdf.Array) else ([kids] if kids is not None else [])
            current_ref = ref_string(obj)
            for index, kid in enumerate(kid_list):
                if not isinstance(kid, pikepdf.Dictionary) or ref_string(kid) != current_ref:
                    continue
                previous = kid_list[index - 1] if index > 0 else None
                if not isinstance(previous, pikepdf.Dictionary):
                    break
                previous_ref = ref_string(previous)
                previous_tag = str(previous.get("/S", ""))
                previous_mcids = normalized_struct_elem_mcids(previous)
                previous_page = page_ref_for_struct_elem(previous)
                previous_page_ref = ref_string(previous_page) if isinstance(previous_page, pikepdf.Dictionary) else None
                previous_usage = page_usage.setdefault(previous_page_ref, page_mcid_analysis(previous_page)) if previous_page_ref and isinstance(previous_page, pikepdf.Dictionary) else {}
                previous_has_text = any(previous_usage.get(mcid, {}).get("hasText") for mcid in previous_mcids)
                previous_has_graphics = any(previous_usage.get(mcid, {}).get("hasGraphics") for mcid in previous_mcids)
                if (
                    previous_ref
                    and previous_tag
                    and previous_tag != "/Figure"
                    and previous_page_ref == page_ref
                    and mcids
                    and has_graphics
                    and not has_text
                    and previous_mcids
                    and previous_has_text
                    and not previous_has_graphics
                ):
                    split_generated = True
                    split_source_ref = previous_ref
                    split_source_tag = previous_tag
                break
        figures.append({
            "ref": ref_string(obj),
            "tag": tag,
            "hasAlt": bool(alt_text),
            "altText": alt_text,
            "childFigureCount": count_descendant_figures(obj),
            "parentTagPath": parent_tag_path(obj),
            "pageRef": page_ref,
            "mcids": mcids,
            "hasText": has_text,
            "graphicsLikelyDecorative": all(usage.get(mcid, {}).get("graphicsLikelyDecorative") for mcid in mcids) if has_graphics else False,
            "splitGenerated": split_generated,
            "splitSourceRef": split_source_ref,
            "splitSourceTag": split_source_tag,
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
                usage.setdefault(mcid, {
                    "hasText": False,
                    "hasGraphics": False,
                    "splitSafe": False,
                    "graphicsLikelyDecorative": False,
                    "operatorPattern": None,
                    "textOpCount": 0,
                    "graphicsOpCount": 0,
                })
            continue
        if operator == "EMC":
            if stack:
                stack.pop()
            continue
        active_mcids = [mcid for mcid in stack if mcid is not None]
        if not active_mcids:
            continue
        has_text = operator in TEXT_SHOWING_OPERATORS
        has_graphics = operator in GRAPHICS_OPERATORS
        if not has_text and not has_graphics:
            continue
        for mcid in active_mcids:
            entry = usage.setdefault(mcid, {
                "hasText": False,
                "hasGraphics": False,
                "splitSafe": False,
                "graphicsLikelyDecorative": False,
                "operatorPattern": None,
                "textOpCount": 0,
                "graphicsOpCount": 0,
            })
            if has_text:
                entry["hasText"] = True
                entry["textOpCount"] = int(entry.get("textOpCount") or 0) + 1
            if has_graphics:
                entry["hasGraphics"] = True
                entry["graphicsOpCount"] = int(entry.get("graphicsOpCount") or 0) + 1
    return usage


def visible_operator_kind(instruction):
    operator = str(instruction.operator)
    if operator in TEXT_SHOWING_OPERATORS:
        return "text"
    if operator in GRAPHICS_OPERATORS:
        return "graphics"
    return None


def split_group_into_text_and_graphics_segments(group):
    if len(group) < 2:
        return None
    if str(group[0].operator) not in MARKED_CONTENT_START_OPERATORS or str(group[-1].operator) != "EMC":
        return None

    inner = group[1:-1]
    if not inner:
        return None

    segments = []
    graphics_buffer = []
    saw_text_outside_bt = False
    saw_graphics_inside_text = False
    saw_text_segment = False
    saw_graphics_segment = False

    def flush_graphics():
        nonlocal graphics_buffer, saw_graphics_segment
        if not graphics_buffer:
            return
        has_visible_graphics = any(visible_operator_kind(instruction) == "graphics" for instruction in graphics_buffer)
        if has_visible_graphics:
            saw_graphics_segment = True
            segments.append({
                "kind": "graphics",
                "instructions": list(graphics_buffer),
                "hasVisibleGraphics": True,
            })
        else:
            if segments:
                segments[-1]["instructions"].extend(graphics_buffer)
            else:
                segments.append({
                    "kind": "graphics",
                    "instructions": list(graphics_buffer),
                    "hasVisibleGraphics": False,
                })
        graphics_buffer = []

    index = 0
    while index < len(inner):
        instruction = inner[index]
        operator = str(instruction.operator)
        if operator in TEXT_SHOWING_OPERATORS:
            saw_text_outside_bt = True
        if operator == "BT":
            flush_graphics()
            text_block = [instruction]
            depth = 1
            index += 1
            while index < len(inner):
                nested = inner[index]
                nested_operator = str(nested.operator)
                text_block.append(nested)
                if nested_operator == "BT":
                    depth += 1
                elif nested_operator == "ET":
                    depth -= 1
                    if depth == 0:
                        break
                elif nested_operator in GRAPHICS_OPERATORS:
                    saw_graphics_inside_text = True
                index += 1
            saw_text_segment = True
            segments.append({
                "kind": "text",
                "instructions": text_block,
                "hasVisibleGraphics": False,
            })
        else:
            graphics_buffer.append(instruction)
        index += 1

    flush_graphics()

    visible_kinds = [
        segment["kind"]
        for segment in segments
        if segment["kind"] == "text" or segment.get("hasVisibleGraphics")
    ]
    if not saw_text_segment or not saw_graphics_segment:
        return {
            "splitSafe": False,
            "operatorPattern": "interleaved",
            "graphicsLikelyDecorative": False,
            "segments": segments,
        }

    split_safe = not saw_text_outside_bt and not saw_graphics_inside_text

    # Even when not strictly split-safe, if the segments cleanly alternate between
    # text blocks (BT/ET) and graphics blocks with no interleaved text-outside-BT,
    # we can still determine the operator pattern for downstream repair decisions.
    operator_pattern = "interleaved"
    if visible_kinds:
        first_visible = visible_kinds[0]
        last_visible = visible_kinds[-1]
        if first_visible != last_visible:
            operator_pattern = "graphics_then_text" if first_visible == "graphics" else "text_then_graphics"
        elif first_visible == "text":
            operator_pattern = "text_then_graphics" if saw_graphics_segment else "interleaved"
        else:
            operator_pattern = "graphics_then_text" if saw_text_segment else "interleaved"

    graphics_ops = [
        str(instruction.operator)
        for segment in segments
        if segment["kind"] == "graphics"
        for instruction in segment["instructions"]
        if str(instruction.operator) in GRAPHICS_OPERATORS
    ]
    # Graphics are likely decorative (lines/borders) if they only use path/stroke ops
    graphics_likely_decorative = bool(graphics_ops) and all(op in {"m", "l", "S", "s", "re", "n", "c", "v", "y", "h", "f", "F", "f*", "B", "B*", "b", "b*", "W", "W*"} for op in graphics_ops)

    return {
        "splitSafe": split_safe,
        "operatorPattern": operator_pattern,
        "graphicsLikelyDecorative": graphics_likely_decorative,
        "segments": segments,
    }


def page_mcid_analysis(page_obj):
    usage = page_mcid_usage(page_obj)
    groups = parse_top_level_content_groups(page_obj)
    for is_marked, group in groups:
        if is_marked is not True or len(group) < 2:
            continue
        operands = list(group[0].operands)
        if len(operands) < 2 or not isinstance(operands[1], pikepdf.Dictionary):
            continue
        raw_mcid = operands[1].get("/MCID")
        if raw_mcid is None:
            continue
        try:
            mcid = int(raw_mcid)
        except Exception:
            continue
        split_info = split_group_into_text_and_graphics_segments(group)
        if not split_info:
            continue
        entry = usage.setdefault(mcid, {
            "hasText": False,
            "hasGraphics": False,
            "splitSafe": False,
            "graphicsLikelyDecorative": False,
            "operatorPattern": None,
            "textOpCount": 0,
            "graphicsOpCount": 0,
        })
        entry["splitSafe"] = bool(split_info["splitSafe"])
        entry["graphicsLikelyDecorative"] = bool(split_info["graphicsLikelyDecorative"])
        entry["operatorPattern"] = split_info["operatorPattern"]
    return usage


def image_struct_candidates(pdf):
    candidates = {}
    page_usage = {}
    for obj in iter_struct_elems(pdf):
        tag = str(obj.get("/S"))
        if tag in {"/Figure", "/Document"}:
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
        usage = page_usage.setdefault(page_ref, page_mcid_analysis(page_obj))
        has_graphics = any(usage.get(mcid, {}).get("hasGraphics") for mcid in mcids)
        has_text = any(usage.get(mcid, {}).get("hasText") for mcid in mcids)
        if not has_graphics:
            continue
        raw_alt = obj.get("/Alt")
        alt_text = str(raw_alt).replace("u:", "") if raw_alt is not None else None
        candidate = {
            "ref": ref_string(obj),
            "tag": tag,
            "hasAlt": bool(alt_text),
            "altText": alt_text,
            "parentTagPath": parent_tag_path(obj),
            "mcids": mcids,
            "hasText": has_text,
            "graphicsDominant": (
                sum(int(usage.get(mcid, {}).get("graphicsOpCount") or 0) for mcid in mcids)
                >= max(3, sum(int(usage.get(mcid, {}).get("textOpCount") or 0) for mcid in mcids) * 3)
            ),
        }
        key = (page_ref, tuple(mcids))
        current = candidates.get(key)
        if current is None:
            candidates[key] = candidate
            continue
        current_depth = len(current.get("parentTagPath") or [])
        next_depth = len(candidate.get("parentTagPath") or [])
        current_rank = (
            current.get("tag") not in {"/Sect", "/Div", "/Document"},
            current_depth,
            current.get("hasText") is False,
        )
        next_rank = (
            candidate.get("tag") not in {"/Sect", "/Div", "/Document"},
            next_depth,
            candidate.get("hasText") is False,
        )
        if next_rank > current_rank:
            candidates[key] = candidate
    return [candidate for candidate in candidates.values() if candidate["ref"]]


ACROBAT_ALT_RISK_CONTAINER_TAGS = {"/Sect", "/Div", "/Part"}


def struct_elem_mcid_info(pdf):
    page_usage_by_ref = {}
    entries = []
    grouped = {}
    for obj in iter_struct_elems(pdf):
        tag = str(obj.get("/S"))
        if tag == "/Document":
            continue
        mcids = normalized_struct_elem_mcids(obj)
        if not mcids:
            continue
        direct_mcids = direct_struct_elem_mcids(obj)
        page_obj = page_ref_for_struct_elem(obj)
        if not isinstance(page_obj, pikepdf.Dictionary):
            continue
        page_ref = ref_string(page_obj)
        if not page_ref:
            continue
        usage = page_usage_by_ref.setdefault(page_ref, page_mcid_analysis(page_obj))
        has_graphics = any(usage.get(mcid, {}).get("hasGraphics") for mcid in mcids)
        has_text = any(usage.get(mcid, {}).get("hasText") for mcid in mcids)
        direct_has_graphics = any(usage.get(mcid, {}).get("hasGraphics") for mcid in direct_mcids)
        direct_has_text = any(usage.get(mcid, {}).get("hasText") for mcid in direct_mcids)
        direct_text_op_count = sum(int(usage.get(mcid, {}).get("textOpCount") or 0) for mcid in direct_mcids)
        direct_graphics_op_count = sum(int(usage.get(mcid, {}).get("graphicsOpCount") or 0) for mcid in direct_mcids)
        split_safe = any(usage.get(mcid, {}).get("splitSafe") for mcid in mcids)
        graphics_likely_decorative = all(usage.get(mcid, {}).get("graphicsLikelyDecorative") for mcid in mcids) if has_graphics else False
        operator_pattern = next((usage.get(mcid, {}).get("operatorPattern") for mcid in mcids if usage.get(mcid, {}).get("operatorPattern")), None)
        graphics_dominant = direct_has_graphics and (
            not direct_has_text
            or direct_graphics_op_count >= max(3, direct_text_op_count * 3)
            or (
                len(direct_mcids) == 1
                and operator_pattern in {"graphics_then_text", "text_then_graphics"}
                and direct_text_op_count <= 1
                and direct_graphics_op_count >= 2
            )
        )
        entry = {
            "ref": ref_string(obj),
            "tag": tag,
            "obj": obj,
            "pageRef": page_ref,
            "mcids": list(mcids),
            "directMcids": list(direct_mcids),
            "hasText": has_text,
            "hasGraphics": has_graphics,
            "directHasText": direct_has_text,
            "directHasGraphics": direct_has_graphics,
            "splitSafe": split_safe,
            "graphicsLikelyDecorative": graphics_likely_decorative,
            "graphicsDominant": graphics_dominant,
            "textOpCount": direct_text_op_count,
            "graphicsOpCount": direct_graphics_op_count,
            "operatorPattern": operator_pattern,
            "parentTagPath": parent_tag_path(obj),
        }
        entries.append(entry)
        grouped.setdefault((page_ref, mcids), []).append(entry)
    return entries, grouped


def acrobat_alt_risk_nodes(pdf):
    entries, grouped = struct_elem_mcid_info(pdf)
    risks = []
    seen_refs = set()
    for entry in entries:
        if not entry["hasGraphics"]:
            continue
        k_value = entry["obj"].get("/K") if isinstance(entry.get("obj"), pikepdf.Dictionary) else None
        has_struct_children = False
        if isinstance(k_value, pikepdf.Array):
          has_struct_children = any(
              isinstance(item, pikepdf.Dictionary) and (
                  str(item.get("/Type")) == "/StructElem"
                  or item.get("/S") is not None
              )
              for item in k_value
          )
        elif isinstance(k_value, pikepdf.Dictionary):
          has_struct_children = (
              str(k_value.get("/Type")) == "/StructElem"
              or k_value.get("/S") is not None
          )
        duplicates = [candidate["ref"] for candidate in grouped.get((entry["pageRef"], tuple(entry["mcids"])), []) if candidate["ref"] != entry["ref"]]
        ownership_mode = None
        if duplicates:
            ownership_mode = "duplicate_mcid_ownership"
        elif entry.get("directHasText") and entry.get("directHasGraphics"):
            has_unsafe_ancestry = any(tag in UNSAFE_FIGURE_ANCESTRY for tag in (entry.get("parentTagPath") or []))
            if (
                entry.get("graphicsDominant")
                and entry["tag"] in SAFE_FIGURE_RETAG_TAGS
                and not has_unsafe_ancestry
            ):
                ownership_mode = "graphics_only_nonfigure"
            else:
                ownership_mode = "mixed_text_graphics_same_mcid"
        elif entry.get("directHasGraphics") and entry["tag"] != "/Figure":
            ownership_mode = "graphics_only_nonfigure"
        if entry["tag"] in ACROBAT_ALT_RISK_CONTAINER_TAGS and has_struct_children and entry.get("directMcids"):
            ownership_mode = "container_with_graphics_descendants" if duplicates or entry["hasGraphics"] else ownership_mode
        if entry["tag"] == "/Figure":
            continue
        if ownership_mode is None:
            continue
        obj = entry.get("obj")
        has_alt = isinstance(obj, pikepdf.Dictionary) and obj.get("/Alt") is not None
        seen_refs.add(entry["ref"])
        risks.append({
            "ref": entry["ref"],
            "tag": entry["tag"],
            "pageRef": entry["pageRef"],
            "mcids": entry["mcids"],
            "hasText": entry["hasText"],
            "hasGraphics": entry["hasGraphics"],
            "hasAlt": has_alt,
            "splitSafe": entry.get("splitSafe", False),
            "graphicsLikelyDecorative": entry.get("graphicsLikelyDecorative", False),
            "graphicsDominant": entry.get("graphicsDominant", False),
            "textOpCount": entry.get("textOpCount", 0),
            "graphicsOpCount": entry.get("graphicsOpCount", 0),
            "operatorPattern": entry.get("operatorPattern"),
            "parentTagPath": entry["parentTagPath"],
            "ownershipMode": ownership_mode,
            "duplicateOwnerRefs": duplicates,
        })

    # Also find struct elements that have /Alt but no MCID content (empty /K or /K array).
    # These trigger Adobe's "Associated with content" failure: the element has /Alt but no
    # actual content backing it. This happens when duplicate-MCID cleanup removes the only
    # scalar MCID from a bootstrapped heading element, leaving it empty but retaining /Alt.
    root = get_struct_tree_root(pdf)
    if isinstance(root, pikepdf.Dictionary):
        visited_orphan = set()
        def scan_orphaned_alt(node):
            try:
                obj = node if isinstance(node, pikepdf.Dictionary) else None
                if obj is None:
                    return
                node_ref = ref_string(obj)
                if not node_ref or node_ref in visited_orphan:
                    return
                visited_orphan.add(node_ref)
                tag = str(obj.get("/S", ""))
                kids = obj.get("/K")
                has_alt = obj.get("/Alt") is not None
                has_mcid_kid = False
                has_struct_kid = False
                has_objr_kid = False
                kid_list = list(kids) if isinstance(kids, pikepdf.Array) else ([kids] if kids is not None else [])
                for kid in kid_list:
                    if isinstance(kid, (int, pikepdf.Integer)):
                        has_mcid_kid = True
                    elif isinstance(kid, pikepdf.Dictionary):
                        ktype = str(kid.get("/Type", ""))
                        if ktype == "/OBJR":
                            has_objr_kid = True
                        else:
                            has_struct_kid = True
                            scan_orphaned_alt(kid)
                # Flag this element if it has /Alt but no content kids of any kind.
                # Elements with OBJR children reference annotation objects (e.g. image
                # hyperlinks) and are NOT truly empty — do not strip their /Alt.
                if has_alt and not has_mcid_kid and not has_struct_kid and not has_objr_kid and node_ref not in seen_refs:
                    pg = obj.get("/Pg")
                    page_ref = ref_string(pg) if isinstance(pg, pikepdf.Dictionary) else None
                    risks.append({
                        "ref": node_ref,
                        "tag": tag,
                        "pageRef": page_ref,
                        "mcids": [],
                        "hasText": False,
                        "hasGraphics": False,
                        "hasAlt": True,
                        "splitSafe": False,
                        "graphicsLikelyDecorative": False,
                        "operatorPattern": None,
                        "parentTagPath": [],
                        "ownershipMode": "orphaned_alt_empty_element",
                        "duplicateOwnerRefs": [],
                    })
            except Exception:
                pass

        doc_kids = root.get("/K")
        if doc_kids is not None:
            top_list = list(doc_kids) if isinstance(doc_kids, pikepdf.Array) else [doc_kids]
            for top in top_list:
                if isinstance(top, pikepdf.Dictionary):
                    scan_orphaned_alt(top)

        # Scan for non-Figure, non-Formula struct elements that have /Alt set AND
        # have actual content kids (MCIDs or struct children). Adobe's
        # "Other elements alternate text" check fails for any such element — /Alt
        # is only valid on /Figure and /Formula elements per PDF/UA.
        visited_nonfigure_alt = set()
        def scan_nonfigure_with_alt(node):
            try:
                obj = node if isinstance(node, pikepdf.Dictionary) else None
                if obj is None:
                    return
                node_ref = ref_string(obj)
                if not node_ref or node_ref in visited_nonfigure_alt:
                    return
                visited_nonfigure_alt.add(node_ref)
                tag = str(obj.get("/S", ""))
                if tag in ("/Figure", "/Formula"):
                    # These are allowed to carry /Alt — skip
                    kids = obj.get("/K")
                    if kids is not None:
                        kid_list = list(kids) if isinstance(kids, pikepdf.Array) else [kids]
                        for kid in kid_list:
                            if isinstance(kid, pikepdf.Dictionary) and str(kid.get("/Type", "")) not in ("/MCR", "/OBJR"):
                                scan_nonfigure_with_alt(kid)
                    return
                has_alt = obj.get("/Alt") is not None
                kids = obj.get("/K")
                has_any_kid = False
                kid_list = list(kids) if isinstance(kids, pikepdf.Array) else ([kids] if kids is not None else [])
                child_structs = []
                for kid in kid_list:
                    if isinstance(kid, (int, pikepdf.Integer)):
                        has_any_kid = True
                    elif isinstance(kid, pikepdf.Dictionary):
                        ktype = str(kid.get("/Type", ""))
                        if ktype == "/MCR":
                            has_any_kid = True
                        elif ktype != "/OBJR":
                            has_any_kid = True
                            child_structs.append(kid)
                # Flag non-Figure elements with /Alt AND actual content
                if has_alt and has_any_kid and node_ref not in seen_refs:
                    pg = obj.get("/Pg")
                    page_ref = ref_string(pg) if isinstance(pg, pikepdf.Dictionary) else None
                    seen_refs.add(node_ref)
                    risks.append({
                        "ref": node_ref,
                        "tag": tag,
                        "pageRef": page_ref,
                        "mcids": [],
                        "hasText": False,
                        "hasGraphics": False,
                        "hasAlt": True,
                        "splitSafe": False,
                        "graphicsLikelyDecorative": False,
                        "operatorPattern": None,
                        "parentTagPath": [],
                        "ownershipMode": "nonfigure_with_alt",
                        "duplicateOwnerRefs": [],
                    })
                for child in child_structs:
                    scan_nonfigure_with_alt(child)
            except Exception:
                pass

        for top in top_list:
            if isinstance(top, pikepdf.Dictionary):
                scan_nonfigure_with_alt(top)

        # Fallback sweep: some indirect StructElem nodes can evade the tree-walk path
        # above depending on how pikepdf materializes descendants. Acrobat still flags
        # any non-/Figure, non-/Formula element carrying /Alt, so do a final whole-doc
        # pass over all structure elements and report any remaining offenders.
        for obj in iter_struct_elems(pdf):
            try:
                node_ref = ref_string(obj)
                if not node_ref or node_ref in seen_refs:
                    continue
                tag = str(obj.get("/S", ""))
                if tag in ("/Figure", "/Formula"):
                    continue
                if obj.get("/Alt") is None:
                    continue
                pg = obj.get("/Pg")
                page_ref = ref_string(pg) if isinstance(pg, pikepdf.Dictionary) else None
                seen_refs.add(node_ref)
                risks.append({
                    "ref": node_ref,
                    "tag": tag,
                    "pageRef": page_ref,
                    "mcids": normalized_struct_elem_mcids(obj),
                    "hasText": False,
                    "hasGraphics": False,
                    "hasAlt": True,
                    "splitSafe": False,
                    "graphicsLikelyDecorative": False,
                    "operatorPattern": None,
                    "parentTagPath": [],
                    "ownershipMode": "nonfigure_with_alt",
                    "duplicateOwnerRefs": [],
                })
            except Exception:
                pass

    # Phase 4: Find image XObjects invoked in content streams where the MCID is not
    # claimed by any struct element. Adobe's "Other elements alternate text" check
    # fails for any rendered image that has no struct-tree owner, even if it is inside
    # a marked-content section with a valid MCID.
    # Use the ParentTree as the canonical ownership authority — it maps each page's
    # MCID indices to struct elements and is more reliable than walking /K chains.
    try:
        from pikepdf import parse_content_stream as _parse_cs
        # Build set of (page_ref_str, mcid_int) pairs already owned via ParentTree
        owned_image_keys = set()
        pt_root = get_struct_tree_root(pdf)
        pt = pt_root.get("/ParentTree") if isinstance(pt_root, pikepdf.Dictionary) else None
        pt_nums = pt.get("/Nums") if isinstance(pt, pikepdf.Dictionary) else None
        if isinstance(pt_nums, pikepdf.Array):
            idx = 0
            while idx + 1 < len(pt_nums):
                page_key = pt_nums[idx]
                entry_arr = pt_nums[idx + 1]
                if isinstance(entry_arr, pikepdf.Array):
                    # Find which page has StructParents == page_key
                    for page in pdf.pages:
                        try:
                            sp = page.get("/StructParents")
                            if sp is not None and int(sp) == int(page_key):
                                page_ref_str = ref_string(page)
                                for mcid_idx, owner in enumerate(entry_arr):
                                    try:
                                        if owner is None or str(owner) in ("null", ""):
                                            continue
                                        # Only count as properly owned if the owner is a /Figure
                                        # or /Formula — these are the only elements allowed to
                                        # carry /Alt for images. Non-Figure owners (e.g. /Sect
                                        # with empty /K) still leave the image untagged for Adobe.
                                        owner_tag = str(owner.get("/S", "")) if isinstance(owner, pikepdf.Dictionary) else ""
                                        if owner_tag in ("/Figure", "/Formula"):
                                            owned_image_keys.add((page_ref_str, mcid_idx))
                                    except Exception:
                                        # Conservative: treat as owned to avoid false positives
                                        owned_image_keys.add((page_ref_str, mcid_idx))
                                break
                        except Exception:
                            pass
                idx += 2

        seen_untagged_keys = set()
        for page_num, page in enumerate(pdf.pages, 1):
            page_ref_str = ref_string(page)
            resources = page.get("/Resources", {})
            xobjects = resources.get("/XObject", {}) if resources else {}
            image_names = set()
            for name, xobj in xobjects.items():
                try:
                    if str(xobj.get("/Subtype", "")) == "/Image":
                        image_names.add(str(name))
                except Exception:
                    pass
            if not image_names:
                continue

            marked_content_stack = []
            try:
                for operands, operator in _parse_cs(page):
                    op = str(operator)
                    if op in ("BMC", "BDC"):
                        entry = {
                            "artifact": False,
                            "mcid": None,
                        }
                        for operand in operands:
                            if str(operand) == "/Artifact":
                                entry["artifact"] = True
                            if isinstance(operand, pikepdf.Dictionary):
                                mcid_val = operand.get("/MCID")
                                if mcid_val is not None:
                                    entry["mcid"] = int(mcid_val)
                        marked_content_stack.append(entry)
                    elif op == "EMC":
                        if marked_content_stack:
                            marked_content_stack.pop()
                    elif op == "Do":
                        xobj_name = str(operands[0]) if operands else ""
                        if xobj_name in image_names:
                            in_artifact = any(entry.get("artifact") for entry in marked_content_stack)
                            current_mcid = None
                            for entry in reversed(marked_content_stack):
                                if entry.get("mcid") is not None:
                                    current_mcid = entry.get("mcid")
                                    break
                            if in_artifact:
                                continue
                            if current_mcid is not None:
                                key = (page_ref_str, current_mcid)
                                if key not in owned_image_keys and key not in seen_untagged_keys:
                                    seen_untagged_keys.add(key)
                                    risks.append({
                                        "ref": f"page:{page_num}:mcid:{current_mcid}",
                                        "tag": "(untagged)",
                                        "pageRef": page_ref_str,
                                        "pageNum": page_num,
                                        "mcids": [current_mcid],
                                        "hasText": False,
                                        "hasGraphics": True,
                                        "hasAlt": False,
                                        "splitSafe": False,
                                        "graphicsLikelyDecorative": True,
                                        "operatorPattern": None,
                                        "parentTagPath": [],
                                        "ownershipMode": "untagged_image_mcid",
                                        "duplicateOwnerRefs": [],
                                        "xobjName": xobj_name,
                                    })
                            else:
                                # Image invoked at depth 0 — no BDC wrapper at all.
                                # These are completely invisible to Phase 1-3 detection.
                                key = (page_ref_str, f"raw:{xobj_name}")
                                if key not in seen_untagged_keys:
                                    seen_untagged_keys.add(key)
                                    risks.append({
                                        "ref": f"page:{page_num}:raw:{xobj_name}",
                                        "tag": "(untagged)",
                                        "pageRef": page_ref_str,
                                        "pageNum": page_num,
                                        "mcids": [],
                                        "hasText": False,
                                        "hasGraphics": True,
                                        "hasAlt": False,
                                        "splitSafe": False,
                                        "graphicsLikelyDecorative": True,
                                        "operatorPattern": None,
                                        "parentTagPath": [],
                                        "ownershipMode": "untagged_image_direct",
                                        "duplicateOwnerRefs": [],
                                        "xobjName": xobj_name,
                                    })
            except Exception:
                pass
    except Exception:
        pass

    return risks


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
    headings = mutation.get("headings") or []
    figures = mutation.get("figures") or []
    if not headings and not figures:
        return False, [], ["bootstrap_struct_tree requires heading or figure candidates."]
    applied = []
    if root is None:
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
        applied.append({
            "ref": ref_string(struct_root),
            "before": None,
            "after": "/StructTreeRoot",
            "details": f"Created a new structure tree rooted at {ref_string(struct_root)}.",
        })
    else:
        struct_root = root
        document = ensure_document_struct_elem(pdf, struct_root)
        if not isinstance(document.get("/K"), pikepdf.Array):
            existing_kids = document.get("/K")
            document["/K"] = pikepdf.Array([existing_kids]) if existing_kids is not None else pikepdf.Array()
        applied.append({
            "ref": ref_string(document),
            "before": "/Document",
            "after": "/Document",
            "details": f"Augmented existing structure tree under {ref_string(document)}.",
        })

    next_mcid = next_available_struct_mcid(pdf)

    normalized_heading_levels = normalize_heading_sequence([
        entry.get("level") or "H2"
        for entry in headings
    ])
    for index, heading in enumerate(headings):
        level = f"/{str(normalized_heading_levels[index] if index < len(normalized_heading_levels) else 'H2').lstrip('/')}"
        heading_text = str(heading.get("text") or "Untitled heading").strip() or "Untitled heading"
        page_obj = page_obj_by_number(pdf, heading.get("pageNumber"))
        element = pdf.make_indirect(pikepdf.Dictionary({
            "/Type": pikepdf.Name("/StructElem"),
            "/S": pikepdf.Name(level),
            "/P": document,
            "/K": next_mcid,
            # Note: do NOT set /Alt on heading elements. Adobe's "Other elements
            # alternate text" check fails for any non-Figure/non-Formula element
            # that carries /Alt. Heading text is already accessible via its MCIDs.
        }))
        if page_obj is not None:
            element["/Pg"] = page_obj
        document["/K"].append(element)
        applied.append({
            "ref": ref_string(element),
            "before": None,
            "after": level,
            "details": f"Created heading tag {level} for \"{heading_text}\".",
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


def normalize_language_tag(language):
    raw = str(language or "").strip().replace("_", "-")
    if not raw:
        return "en"

    parts = [part for part in raw.split("-") if part]
    if not parts:
        return "en"

    normalized = []
    for index, part in enumerate(parts):
        if index == 0:
            normalized.append(part.lower())
        elif re.fullmatch(r"[A-Za-z]{4}", part):
            normalized.append(part[:1].upper() + part[1:].lower())
        elif re.fullmatch(r"[A-Za-z]{2}", part) or re.fullmatch(r"\d{3}", part):
            normalized.append(part.upper())
        else:
            normalized.append(part.lower())
    return "-".join(normalized)


def mutate_set_pdfua_identification(pdf, mutation):
    catalog = get_catalog(pdf)
    if catalog is None:
        return False, [], ["Could not locate the PDF catalog to attach metadata."]

    title = str(mutation.get("title") or "").strip() or "Accessible PDF"
    language = normalize_language_tag(mutation.get("language") or "en")
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
    if isinstance(kids, pikepdf.Array):
        kids.append(document)
    elif kids is None:
        struct_root["/K"] = pikepdf.Array([document])
    else:
        struct_root["/K"] = pikepdf.Array([kids, document])
    return document


def next_available_struct_mcid(pdf):
    reserved = set()
    try:
        for obj in iter_struct_elems(pdf):
            reserved.update(mcid for mcid in normalized_struct_elem_mcids(obj) if isinstance(mcid, int))
    except Exception:
        pass
    try:
        for page in pdf.pages:
            reserved.update(extract_page_mcids(page.obj))
    except Exception:
        pass
    return (max(reserved) + 1) if reserved else 0


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


def normalized_struct_elem_mcids(obj):
    mcids = []
    collect_mcids(obj.get("/K"), mcids)
    return tuple(sorted(set(mcid for mcid in mcids if isinstance(mcid, int))))


def direct_struct_elem_mcids(obj):
    kids = obj.get("/K") if isinstance(obj, pikepdf.Dictionary) else None
    mcids = []
    if isinstance(kids, int):
        mcids.append(int(kids))
    elif isinstance(kids, pikepdf.Array):
        for item in kids:
            if isinstance(item, int):
                mcids.append(int(item))
            elif isinstance(item, pikepdf.Dictionary) and str(item.get("/Type", "")) == "/MCR":
                mcid = item.get("/MCID")
                try:
                    mcids.append(int(mcid))
                except Exception:
                    pass
    elif isinstance(kids, pikepdf.Dictionary) and str(kids.get("/Type", "")) == "/MCR":
        mcid = kids.get("/MCID")
        try:
            mcids.append(int(mcid))
        except Exception:
            pass
    return tuple(sorted(set(mcid for mcid in mcids if isinstance(mcid, int))))


def alt_text_for_matching_page_mcid_struct_elem(pdf, page_obj, mcids):
    page_ref = ref_string(page_obj)
    for candidate in iter_struct_elems(pdf):
        if str(candidate.get("/S")) == "/Document":
            continue
        if ref_string(candidate.get("/Pg")) != page_ref:
            continue
        if normalized_struct_elem_mcids(candidate) != mcids:
            continue
        raw_alt = candidate.get("/Alt")
        alt_text = str(raw_alt).replace("u:", "") if raw_alt is not None else ""
        if alt_text.strip():
            return alt_text.strip()
    return None


ALT_TEXT_LEAF_TAGS = {"/Figure", "/Formula"}
ALT_TEXT_CONTAINER_TAGS = {"/Sect", "/Div", "/Part", "/Document"}


def mirror_alt_text_to_matching_struct_elems(pdf, source_obj, alt_text):
    normalized_alt = str(alt_text or "").strip()
    if not normalized_alt or not isinstance(source_obj, pikepdf.Dictionary):
        return []
    page_obj = source_obj.get("/Pg")
    if not isinstance(page_obj, pikepdf.Dictionary):
        return []
    page_ref = ref_string(page_obj)
    mcids = normalized_struct_elem_mcids(source_obj)
    if not mcids:
        return []
    source_ref = ref_string(source_obj)
    applied = []
    for candidate in iter_struct_elems(pdf):
        if ref_string(candidate) == source_ref or str(candidate.get("/S")) == "/Document":
            continue
        if ref_string(candidate.get("/Pg")) != page_ref:
            continue
        if normalized_struct_elem_mcids(candidate) != mcids:
            continue
        tag = str(candidate.get("/S"))
        if tag in ALT_TEXT_CONTAINER_TAGS:
            raw_alt = candidate.get("/Alt")
            existing_alt = str(raw_alt).replace("u:", "") if raw_alt is not None else None
            if existing_alt is not None:
                try:
                    del candidate["/Alt"]
                except Exception:
                    pass
                applied.append({
                    "ref": ref_string(candidate),
                    "before": existing_alt,
                    "after": None,
                    "details": f"Removed nested alternate text from container {tag} element {ref_string(candidate)}.",
                })
            continue
        if tag not in ALT_TEXT_LEAF_TAGS:
            continue
        raw_alt = candidate.get("/Alt")
        existing_alt = str(raw_alt).replace("u:", "") if raw_alt is not None else None
        if existing_alt and existing_alt.strip() == normalized_alt:
            continue
        candidate["/Alt"] = pikepdf.String(normalized_alt)
        applied.append({
            "ref": ref_string(candidate),
            "before": existing_alt,
            "after": normalized_alt,
            "details": f"Mirrored alternate text \"{normalized_alt}\" onto matching {str(candidate.get('/S'))} element {ref_string(candidate)}.",
        })
    return applied


def remove_alt_from_descendants(node, skip_ref=None, preserve_leaf_figure_alt=False):
    applied = []
    visited = set()

    def visit(value):
        if not isinstance(value, pikepdf.Dictionary):
            return
        node_ref = ref_string(value)
        if node_ref and node_ref in visited:
            return
        if node_ref:
            visited.add(node_ref)
        tag = str(value.get("/S"))
        kids = value.get("/K")
        child_values = list(kids) if isinstance(kids, pikepdf.Array) else ([kids] if isinstance(kids, pikepdf.Dictionary) else [])
        child_figure_count = sum(1 for child in child_values if isinstance(child, pikepdf.Dictionary) and str(child.get("/S")) == "/Figure")
        if preserve_leaf_figure_alt and tag == "/Figure" and child_figure_count == 0:
            return
        if skip_ref and node_ref == skip_ref:
            pass
        else:
            raw_alt = value.get("/Alt")
            existing_alt = str(raw_alt).replace("u:", "") if raw_alt is not None else None
            if existing_alt is not None:
                try:
                    del value["/Alt"]
                except Exception:
                    pass
                applied.append({
                    "ref": node_ref,
                    "before": existing_alt,
                    "after": None,
                    "details": f"Removed nested alternate text from descendant element {node_ref}.",
                })
        if isinstance(kids, pikepdf.Array):
            for child in kids:
                visit(child)
        elif isinstance(kids, pikepdf.Dictionary):
            visit(kids)

    kids = node.get("/K") if isinstance(node, pikepdf.Dictionary) else None
    if isinstance(kids, pikepdf.Array):
        for child in kids:
            visit(child)
    elif isinstance(kids, pikepdf.Dictionary):
        visit(kids)
    return applied


def has_descendant_leaf_figure_with_alt(node):
    visited = set()

    def visit(value):
        if not isinstance(value, pikepdf.Dictionary):
            return False
        node_ref = ref_string(value)
        if node_ref and node_ref in visited:
            return False
        if node_ref:
            visited.add(node_ref)
        tag = str(value.get("/S"))
        kids = value.get("/K")
        child_values = list(kids) if isinstance(kids, pikepdf.Array) else ([kids] if isinstance(kids, pikepdf.Dictionary) else [])
        child_figure_count = sum(1 for child in child_values if isinstance(child, pikepdf.Dictionary) and str(child.get("/S")) == "/Figure")
        if tag == "/Figure" and child_figure_count == 0:
            raw_alt = value.get("/Alt")
            alt_text = str(raw_alt).replace("u:", "").strip() if raw_alt is not None else ""
            if alt_text:
                return True
        for child in child_values:
            if visit(child):
                return True
        return False

    kids = node.get("/K") if isinstance(node, pikepdf.Dictionary) else None
    if isinstance(kids, pikepdf.Array):
        for child in kids:
            if visit(child):
                return True
    elif isinstance(kids, pikepdf.Dictionary):
        return visit(kids)
    return False


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


def ensure_struct_elem_kids_array(elem, preserve_scalar=True):
    kids = elem.get("/K")
    if isinstance(kids, pikepdf.Array):
        return kids
    if kids is None:
        kids = pikepdf.Array()
    elif not preserve_scalar:
        kids = pikepdf.Array()
    else:
        kids = pikepdf.Array([kids])
    elem["/K"] = kids
    return kids


def _has_child_with_mcid(child, mcid):
    if isinstance(child, pikepdf.Dictionary):
        return mcid in normalized_struct_elem_mcids(child)
    return False


def remove_duplicate_direct_mcids_from_elem(elem):
    kids = elem.get("/K")
    if isinstance(kids, int):
        elem["/K"] = pikepdf.Array()
        # Element is now empty — remove /Alt to prevent "Associated with content" failures.
        # An element with /Alt but no MCID content causes Adobe Acrobat to flag both
        # "Associated with content" and "Other elements alternate text".
        try:
            del elem["/Alt"]
        except Exception:
            pass
        return True, [int(kids)]
    if not isinstance(kids, pikepdf.Array):
        return False, []
    rewritten = pikepdf.Array()
    removed = []
    for child in kids:
        if isinstance(child, int):
            if any(_has_child_with_mcid(other, int(child)) for other in kids if other is not child):
                removed.append(int(child))
                continue
        elif isinstance(child, pikepdf.Dictionary) and str(child.get("/Type", "")) == "/MCR":
            mcid = child.get("/MCID")
            try:
                mcid = int(mcid)
            except Exception:
                mcid = None
            if mcid is not None and any(_has_child_with_mcid(other, mcid) for other in kids if other is not child):
                removed.append(mcid)
                continue
        rewritten.append(child)
    if not removed:
        return False, []
    elem["/K"] = rewritten
    # If rewritten is empty (all MCIDs were duplicates), also remove /Alt
    if len(rewritten) == 0:
        try:
            del elem["/Alt"]
        except Exception:
            pass
    return True, removed


def top_level_mcid_group_index(page_obj, target_mcid):
    groups = parse_top_level_content_groups(page_obj)
    for index, (is_marked, group) in enumerate(groups):
        if is_marked is not True or len(group) < 2:
            continue
        operands = list(group[0].operands)
        if len(operands) < 2 or not isinstance(operands[1], pikepdf.Dictionary):
            continue
        raw_mcid = operands[1].get("/MCID")
        if raw_mcid is None:
            continue
        try:
            mcid = int(raw_mcid)
        except Exception:
            continue
        if mcid == int(target_mcid):
            return groups, index
    return groups, None


def replace_struct_elem_mcids(elem, mcids):
    if not isinstance(elem, pikepdf.Dictionary):
        return
    if not mcids:
        try:
            del elem["/K"]
        except Exception:
            pass
        return
    if len(mcids) == 1:
        elem["/K"] = int(mcids[0])
        return
    elem["/K"] = pikepdf.Array([int(mcid) for mcid in mcids])


def parent_tree_entry_for_page(root, pdf, page_obj):
    parent_tree, nums = ensure_parent_tree(root, pdf)
    try:
        page_key = int(page_obj.get("/StructParents"))
    except Exception:
        page_key = None
    if page_key is None:
        page_key = int(root.get("/ParentTreeNextKey", 0) or 0)
        page_obj["/StructParents"] = page_key
        root["/ParentTreeNextKey"] = page_key + 1
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
    return parent_tree, nums, page_key, current_entry


def create_split_figure_elem(pdf, source_obj, page_obj, alt_text):
    parent = source_obj.get("/P")
    if not isinstance(parent, pikepdf.Dictionary):
        return None
    figure = pdf.make_indirect(pikepdf.Dictionary({
        "/Type": pikepdf.Name("/StructElem"),
        "/S": pikepdf.Name("/Figure"),
        "/P": parent,
        "/Pg": page_obj,
    }))
    normalized_alt = str(alt_text or "").strip()
    if normalized_alt:
        figure["/Alt"] = pikepdf.String(normalized_alt)
    parent_kids = ensure_struct_elem_kids_array(parent)
    source_ref = ref_string(source_obj)
    inserted = False
    updated_kids = pikepdf.Array()
    for child in parent_kids:
        updated_kids.append(child)
        if not inserted and isinstance(child, pikepdf.Dictionary) and ref_string(child) == source_ref:
            updated_kids.append(figure)
            inserted = True
    if not inserted:
        updated_kids.append(figure)
    parent["/K"] = updated_kids
    return figure


def split_safe_mixed_mcid_owner(pdf, source_obj, risk):
    page_obj = source_obj.get("/Pg")
    if not isinstance(page_obj, pikepdf.Dictionary):
        return False, [], [f"{risk['tag']} {risk['ref']} is missing a concrete /Pg reference."], []

    mcids = risk.get("mcids") or []
    if len(mcids) != 1:
        return False, [], [f"{risk['tag']} {risk['ref']} spans multiple MCIDs and is not eligible for deterministic splitting."], []

    target_mcid = int(mcids[0])
    groups, group_index = top_level_mcid_group_index(page_obj, target_mcid)
    if group_index is None:
        return False, [], [f"Could not locate the top-level marked-content group for MCID {target_mcid} on {risk['pageRef']}."], []

    group = groups[group_index][1]
    split_info = split_group_into_text_and_graphics_segments(group)
    visible_segments = [
        segment for segment in (split_info.get("segments") or [])
        if segment.get("kind") == "text" or segment.get("hasVisibleGraphics")
    ] if split_info else []
    relaxed_split_safe = bool(
        split_info
        and split_info.get("operatorPattern") in {"graphics_then_text", "text_then_graphics"}
        and len(visible_segments) <= 2
    )
    if not split_info or (not split_info.get("splitSafe") and not relaxed_split_safe):
        return False, [], [f"{risk['tag']} {risk['ref']} remains in mode mixed_text_graphics_same_mcid."], []

    segments = split_info.get("segments") or []
    if not segments:
        return False, [], [f"No split segments were derived for MCID {target_mcid} on {risk['pageRef']}."], []

    root = get_struct_tree_root(pdf)
    if not isinstance(root, pikepdf.Dictionary):
        return False, [], ["Could not locate the structure tree root for mixed-content alternate-text repair."], []

    page_ref = ref_string(page_obj)
    reserved_mcids = set(extract_page_mcids(page_obj))
    for entry in struct_elem_mcid_info(pdf)[0]:
        if entry.get("pageRef") != page_ref:
            continue
        reserved_mcids.update(entry.get("mcids") or [])

    parent_tree, nums, page_key, current_entry = parent_tree_entry_for_page(root, pdf, page_obj)
    reserved_mcids.update(index for index, owner in enumerate(current_entry) if owner is not None)
    next_mcid = (max(reserved_mcids) + 1) if reserved_mcids else 0
    # When graphics segments are decorative (borders, backgrounds, rule lines),
    # mark them as /Artifact in the content stream instead of /Figure.
    # This removes them from reading order and satisfies Adobe's alt-text check
    # without creating struct-tree Figure siblings that interleave MCIDs.
    graphics_likely_decorative = bool(risk.get("graphicsLikelyDecorative", False))

    text_mcids = []
    graphics_mcids = []
    rewritten_groups = []
    for segment in segments:
        instructions = segment.get("instructions") or []
        if not instructions:
            continue
        if segment["kind"] == "graphics" and not segment.get("hasVisibleGraphics"):
            if rewritten_groups:
                rewritten_groups[-1].extend(instructions)
            else:
                rewritten_groups.append(list(instructions))
            continue
        if segment["kind"] == "graphics" and graphics_likely_decorative:
            # Wrap as /Artifact — no MCID needed, no struct element entry
            wrapped = [
                pikepdf.ContentStreamInstruction([pikepdf.Name("/Artifact")], pikepdf.Operator("BMC")),
                *instructions,
                pikepdf.ContentStreamInstruction([], pikepdf.Operator("EMC")),
            ]
            rewritten_groups.append(wrapped)
            continue
        mcid = next_mcid
        next_mcid += 1
        tag_name = "/Span" if segment["kind"] == "text" else "/Figure"
        props = pikepdf.Dictionary({"/MCID": mcid})
        wrapped = [
            pikepdf.ContentStreamInstruction([pikepdf.Name(tag_name), props], pikepdf.Operator("BDC")),
            *instructions,
            pikepdf.ContentStreamInstruction([], pikepdf.Operator("EMC")),
        ]
        rewritten_groups.append(wrapped)
        if segment["kind"] == "text":
            text_mcids.append(mcid)
        else:
            graphics_mcids.append(mcid)

    if not text_mcids:
        return False, [], [f"{risk['tag']} {risk['ref']} did not produce text segments during splitting."], []
    if not graphics_likely_decorative and not graphics_mcids:
        return False, [], [f"{risk['tag']} {risk['ref']} did not produce graphics segments during splitting."], []

    rewritten = []
    for index, (is_marked, existing_group) in enumerate(groups):
        if index != group_index:
            rewritten.extend(existing_group)
            continue
        for wrapped in rewritten_groups:
            rewritten.extend(wrapped)
    page_obj["/Contents"] = pdf.make_stream(pikepdf.unparse_content_stream(rewritten))

    replace_struct_elem_mcids(source_obj, text_mcids)
    existing_alt = source_obj.get("/Alt")
    if existing_alt is not None:
        try:
            del source_obj["/Alt"]
        except Exception:
            pass

    # Update parent tree: text MCIDs → source element; graphics MCIDs → figure element (if any)
    highest = max(text_mcids + graphics_mcids) if graphics_mcids else max(text_mcids)
    while len(current_entry) <= highest:
        current_entry.append(None)
    current_entry[target_mcid] = None
    for mcid in text_mcids:
        current_entry[mcid] = source_obj

    applied = [{
        "ref": risk["ref"],
        "before": f"MCID {target_mcid}",
        "after": ", ".join(f"MCID {mcid}" for mcid in text_mcids),
        "details": f"Split mixed text and graphics ownership for {risk['tag']} element {risk['ref']} into {len(text_mcids)} text MCID segment(s).",
    }]

    if graphics_likely_decorative:
        # Graphics wrapped as /Artifact — no struct element needed, no parent tree entry
        applied.append({
            "ref": risk["ref"],
            "before": None,
            "after": "artifact",
            "details": f"Wrapped {len(rewritten_groups) - len([g for g in rewritten_groups if g])} decorative graphics segment(s) as /Artifact (no struct element) for {risk['ref']}.",
        })
        upsert_parent_tree_entry(nums, page_key, current_entry)
        root["/ParentTree"] = parent_tree
        return True, applied, [], [{"textMcids": text_mcids, "graphicsMcids": [], "figureRef": None}]

    actual_text = str(source_obj.get("/ActualText") or "").strip()
    # Never synthesize placeholder alt text from the source tag name (e.g. "Sect").
    # Acrobat will still treat that as alternate text on a Figure, but it is low-signal
    # and can cause false confidence while still failing practical review. If we cannot
    # derive meaningful text here, create the sibling Figure without /Alt and let later
    # figure-specific remediation decide whether to set informative alt text or mark the
    # graphic decorative.
    alt_text = actual_text if actual_text else None
    figure_elem = create_split_figure_elem(pdf, source_obj, page_obj, alt_text)
    if not isinstance(figure_elem, pikepdf.Dictionary):
        return False, [], [f"Could not create a sibling /Figure element for {risk['ref']}."], []
    replace_struct_elem_mcids(figure_elem, graphics_mcids)

    for mcid in graphics_mcids:
        current_entry[mcid] = figure_elem
    upsert_parent_tree_entry(nums, page_key, current_entry)
    root["/ParentTree"] = parent_tree

    applied.append({
        "ref": ref_string(figure_elem),
        "before": None,
        "after": ", ".join(f"MCID {mcid}" for mcid in graphics_mcids),
        "details": (
            f"Created sibling /Figure element {ref_string(figure_elem)}"
            f"{f' with alt text \"{alt_text}\"' if alt_text else ' without synthesized alt text'} "
            f"for {len(graphics_mcids)} graphics MCID segment(s)."
        ),
    })
    return True, applied, [], [{"textMcids": text_mcids, "graphicsMcids": graphics_mcids, "figureRef": ref_string(figure_elem)}]


def mutate_repair_other_elements_alt_text(pdf, mutation):
    changed = False
    applied = []
    unresolved = []
    max_repairs = mutation.get("maxRepairsPerRun")
    try:
        max_repairs = max(1, int(max_repairs)) if max_repairs is not None else None
    except Exception:
        max_repairs = None
    repairs_applied = 0
    risks = acrobat_alt_risk_nodes(pdf)
    if not risks:
        return False, [], ["No Acrobat-style alternate-text ownership risks were detected."]
    if max_repairs is None:
        max_repairs = max(32, len(risks))

    normalization_changed = False
    for risk in risks:
        mode = risk.get("ownershipMode")
        if mode not in {"duplicate_mcid_ownership", "container_with_graphics_descendants"}:
            continue
        obj = resolve_obj(pdf, risk.get("ref"))
        if not isinstance(obj, pikepdf.Dictionary):
            continue
        removed_changed, removed_mcids = remove_duplicate_direct_mcids_from_elem(obj)
        if removed_changed:
            changed = True
            normalization_changed = True
            repairs_applied += 1
            applied.append({
                "ref": risk["ref"],
                "before": ", ".join(f"MCID {mcid}" for mcid in removed_mcids),
                "after": "removed duplicate scalar ownership",
                "details": f"Removed duplicate direct MCID ownership from {risk['tag']} element {risk['ref']} for {', '.join(f'MCID {mcid}' for mcid in removed_mcids)}.",
            })

    if normalization_changed:
        risks = acrobat_alt_risk_nodes(pdf)

    if not risks:
        return True, applied, []

    for risk in risks:
        if repairs_applied >= max_repairs:
            unresolved.append(f"Deferred {len(risks)} remaining Acrobat alternate-text ownership risks for a follow-up pass.")
            break
        mode = risk.get("ownershipMode")

        if mode == "untagged_image_mcid":
            # Handled before resolve_obj — these have no real PDF object ref
            page_ref_str = risk.get("pageRef")
            mcid = risk.get("mcids", [None])[0] if risk.get("mcids") else None
            if page_ref_str is None or mcid is None:
                unresolved.append(f"Cannot create Figure for untagged image: missing page ref or MCID.")
                continue
            page_obj = None
            for p in pdf.pages:
                if ref_string(p) == page_ref_str:
                    page_obj = p.obj if hasattr(p, 'obj') else p
                    break
            if page_obj is None:
                unresolved.append(f"Cannot locate page {page_ref_str} to tag untagged image MCID {mcid}.")
                continue
            try:
                struct_root = get_struct_tree_root(pdf)
                if not isinstance(struct_root, pikepdf.Dictionary):
                    unresolved.append(f"No struct tree root for untagged image MCID {mcid}.")
                    continue
                if bool(risk.get("graphicsLikelyDecorative", False)):
                    groups, group_index = top_level_mcid_group_index(page_obj, int(mcid))
                    if group_index is None:
                        unresolved.append(f"Could not locate the top-level marked-content group for decorative image MCID {mcid}.")
                        continue
                    group = groups[group_index][1]
                    if len(group) < 2:
                        unresolved.append(f"Decorative image MCID {mcid} on page {risk.get('pageNum', '?')} did not expose a full marked-content group.")
                        continue
                    artifact_group = [
                        pikepdf.ContentStreamInstruction([pikepdf.Name("/Artifact")], pikepdf.Operator("BMC")),
                        *group[1:-1],
                        pikepdf.ContentStreamInstruction([], pikepdf.Operator("EMC")),
                    ]
                    rewritten = []
                    for index, (_, existing_group) in enumerate(groups):
                        rewritten.extend(artifact_group if index == group_index else existing_group)
                    page_obj["/Contents"] = pdf.make_stream(pikepdf.unparse_content_stream(rewritten))
                    changed = True
                    repairs_applied += 1
                    applied.append({
                        "ref": risk["ref"],
                        "before": f"untagged image MCID {mcid} on page {risk.get('pageNum', '?')}",
                        "after": "/Artifact",
                        "details": (
                            f"Rewrote decorative untagged image '{risk.get('xobjName', '?')}' MCID {mcid} on "
                            f"page {risk.get('pageNum', '?')} as /Artifact to satisfy Acrobat's "
                            f"'Other elements alternate text' check."
                        ),
                    })
                    continue

                # Check whether this MCID is already owned by an existing struct element
                # (e.g. bootstrap created a /P or /H1 for it). If so:
                # - If it's already a /Figure, just ensure /Alt is set.
                # - If it's a non-heading element AND the BDC block contains only image
                #   operators (no text), retag the existing element as /Figure in-place.
                # - Otherwise, skip to avoid corrupting the struct tree.
                page_dict = page_obj if isinstance(page_obj, pikepdf.Dictionary) else page_obj
                parent_tree, nums, page_key, current_entry = parent_tree_entry_for_page(struct_root, pdf, page_dict)
                mcid_int = int(mcid)
                if mcid_int < len(current_entry) and current_entry[mcid_int] is not None:
                    existing = current_entry[mcid_int]
                    if isinstance(existing, pikepdf.Dictionary):
                        existing_tag = str(existing.get("/S", ""))
                        if existing_tag == "/Figure":
                            # Already a /Figure — ensure /Alt is present for semantic enrichment.
                            if existing.get("/Alt") is None:
                                existing["/Alt"] = pikepdf.String("")
                                changed = True
                                repairs_applied += 1
                                applied.append({
                                    "ref": risk["ref"],
                                    "before": f"existing /Figure MCID {mcid} missing /Alt on page {risk.get('pageNum', '?')}",
                                    "after": "/Figure with empty alt (pending semantic enrichment)",
                                    "details": (
                                        f"Added empty /Alt to existing /Figure struct element for image "
                                        f"'{risk.get('xobjName', '?')}' MCID {mcid} on page {risk.get('pageNum', '?')}."
                                    ),
                                })
                            else:
                                unresolved.append(
                                    f"MCID {mcid} on page {risk.get('pageNum', '?')} already has /Figure with /Alt."
                                )
                        elif existing_tag not in ("/H1", "/H2", "/H3", "/H4", "/H5", "/H6"):
                            # Non-heading element: check if the BDC block is image-only.
                            # If so, retag in-place as /Figure (safe because no text content).
                            block_has_text = False
                            try:
                                depth_local = 0
                                in_target_block = False
                                for inst in pikepdf.parse_content_stream(page_obj):
                                    ops_l, op_l = inst
                                    op_str = str(op_l)
                                    if op_str in ("BMC", "BDC"):
                                        for operand in ops_l:
                                            if isinstance(operand, pikepdf.Dictionary):
                                                if int(operand.get("/MCID", -1)) == mcid_int:
                                                    in_target_block = True
                                        depth_local += 1
                                    elif op_str == "EMC":
                                        depth_local -= 1
                                        if in_target_block and depth_local == 0:
                                            break
                                    elif in_target_block and op_str in TEXT_SHOWING_OPERATORS:
                                        block_has_text = True
                                        break
                            except Exception:
                                block_has_text = True  # conservative: assume text present

                            if not block_has_text:
                                existing["/S"] = pikepdf.Name("/Figure")
                                if existing.get("/Alt") is None:
                                    existing["/Alt"] = pikepdf.String("")
                                changed = True
                                repairs_applied += 1
                                applied.append({
                                    "ref": risk["ref"],
                                    "before": f"{existing_tag} MCID {mcid} wraps image-only block on page {risk.get('pageNum', '?')}",
                                    "after": "/Figure with empty alt (pending semantic enrichment)",
                                    "details": (
                                        f"Retagged {existing_tag} → /Figure for image-only MCID {mcid} "
                                        f"on page {risk.get('pageNum', '?')}. "
                                        f"Fixes Adobe 'Other elements alternate text' check."
                                    ),
                                })
                            else:
                                unresolved.append(
                                    f"MCID {mcid} on page {risk.get('pageNum', '?')} is {existing_tag} with mixed "
                                    f"text+image content; cannot safely retag as /Figure."
                                )
                        else:
                            # Heading element — do NOT touch it.
                            unresolved.append(
                                f"MCID {mcid} on page {risk.get('pageNum', '?')} is owned by a "
                                f"{existing_tag} heading; skipping."
                            )
                    continue

                document = ensure_document_struct_elem(pdf, struct_root)
                mcr = pikepdf.Dictionary({
                    "/Type": pikepdf.Name("/MCR"),
                    "/Pg": page_obj,
                    "/MCID": pikepdf.Integer(int(mcid)),
                })
                figure = pdf.make_indirect(pikepdf.Dictionary({
                    "/Type": pikepdf.Name("/StructElem"),
                    "/S": pikepdf.Name("/Figure"),
                    "/P": document,
                    "/Pg": page_obj,
                    "/Alt": pikepdf.String(""),
                    "/K": pikepdf.Array([mcr]),
                }))
                doc_kids = ensure_struct_elem_kids_array(document, preserve_scalar=True)
                doc_kids.append(figure)
                document["/K"] = doc_kids
                while len(current_entry) <= mcid_int:
                    current_entry.append(None)  # pikepdf null
                current_entry[mcid_int] = figure
                upsert_parent_tree_entry(nums, page_key, current_entry)
                changed = True
                repairs_applied += 1
                applied.append({
                    "ref": risk["ref"],
                    "before": f"untagged image MCID {mcid} on page {risk.get('pageNum', '?')}",
                    "after": "/Figure with empty alt (pending semantic enrichment)",
                    "details": (
                        f"Created /Figure struct element for untagged image '{risk.get('xobjName', '?')}' "
                        f"MCID {mcid} on page {risk.get('pageNum', '?')}. "
                        f"Fixes Adobe 'Other elements alternate text' check."
                    ),
                })
            except Exception as exc:
                unresolved.append(f"Could not create Figure for untagged image MCID {mcid}: {exc}")
            continue

        if mode == "untagged_image_direct":
            # Image invoked via `Do` at depth 0 — no BDC/MCID wrapper at all.
            # Strategy: rewrite the page content stream to wrap the `Do` with a
            # new `BDC << /MCID N >> ... EMC` block, then create a /Figure struct
            # element for it and add it to the ParentTree.
            page_ref_str = risk.get("pageRef")
            xobj_name = risk.get("xobjName", "")
            page_num = risk.get("pageNum", "?")
            if not page_ref_str or not xobj_name:
                unresolved.append(f"Cannot tag direct image: missing page ref or xobj name.")
                continue
            page_obj = None
            for p in pdf.pages:
                if ref_string(p) == page_ref_str:
                    page_obj = p.obj if hasattr(p, "obj") else p
                    break
            if page_obj is None:
                unresolved.append(f"Cannot locate page {page_ref_str} for direct image {xobj_name}.")
                continue
            try:
                struct_root = get_struct_tree_root(pdf)
                if not isinstance(struct_root, pikepdf.Dictionary):
                    unresolved.append(f"No struct tree root for direct image {xobj_name}.")
                    continue

                # Determine the next available MCID for this page.
                # Must account for MCIDs already claimed by struct elements in the struct
                # tree (e.g. bootstrap creates heading struct elements with /K: N without
                # adding BDC blocks to the content stream — extract_page_mcids would miss
                # those, causing MCID collisions that corrupt the struct tree).
                existing_mcids = extract_page_mcids(page_obj)
                page_ref_match = ref_string(page_obj)
                struct_claimed_mcids = []
                try:
                    for elem in iter_struct_elems(pdf):
                        elem_pg = elem.get("/Pg")
                        if elem_pg is not None and ref_string(elem_pg) != page_ref_match:
                            continue
                        k = elem.get("/K")
                        if k is None:
                            continue
                        if isinstance(k, pikepdf.Array):
                            for item in k:
                                try:
                                    struct_claimed_mcids.append(int(item))
                                except Exception:
                                    pass
                        else:
                            try:
                                struct_claimed_mcids.append(int(k))
                            except Exception:
                                pass
                except Exception:
                    pass
                all_known_mcids = existing_mcids + struct_claimed_mcids
                new_mcid = (max(all_known_mcids) + 1) if all_known_mcids else 0

                # Rewrite the content stream: wrap depth-0 `Do /xobj_name` with BDC/EMC.
                # We only wrap the FIRST occurrence of this xobj at depth 0 to avoid
                # double-tagging if the same image appears multiple times.
                instructions = list(pikepdf.parse_content_stream(page_obj))
                rewritten = []
                depth = 0
                wrapped_once = False
                for inst in instructions:
                    operands, operator = inst
                    op = str(operator)
                    if op in ("BMC", "BDC"):
                        depth += 1
                    elif op == "EMC":
                        depth -= 1
                    if (
                        not wrapped_once
                        and depth == 0
                        and op == "Do"
                        and operands
                        and str(operands[0]) == xobj_name
                    ):
                        if bool(risk.get("graphicsLikelyDecorative", False)):
                            rewritten.append(
                                pikepdf.ContentStreamInstruction(
                                    [pikepdf.Name("/Artifact")],
                                    pikepdf.Operator("BMC"),
                                )
                            )
                        else:
                            props = pikepdf.Dictionary({"/MCID": pikepdf.Integer(new_mcid)})
                            rewritten.append(
                                pikepdf.ContentStreamInstruction(
                                    [pikepdf.Name("/Figure"), props],
                                    pikepdf.Operator("BDC"),
                                )
                            )
                        rewritten.append(inst)
                        rewritten.append(
                            pikepdf.ContentStreamInstruction([], pikepdf.Operator("EMC"))
                        )
                        wrapped_once = True
                        continue
                    # Pass inst through unchanged — preserves ContentStreamInlineImage
                    rewritten.append(inst)

                if not wrapped_once:
                    unresolved.append(
                        f"Could not find depth-0 Do /{xobj_name} on page {page_num} to wrap."
                    )
                    continue

                page_obj["/Contents"] = pdf.make_stream(
                    pikepdf.unparse_content_stream(rewritten)
                )

                if bool(risk.get("graphicsLikelyDecorative", False)):
                    changed = True
                    repairs_applied += 1
                    applied.append({
                        "ref": risk["ref"],
                        "before": f"untagged depth-0 image '{xobj_name}' on page {page_num}",
                        "after": "/Artifact",
                        "details": (
                            f"Wrapped decorative depth-0 Do /{xobj_name} in /Artifact on page {page_num}. "
                            f"Fixes Acrobat 'Other elements alternate text' without creating a new figure."
                        ),
                    })
                    continue

                # Create MCR and /Figure struct element.
                document = ensure_document_struct_elem(pdf, struct_root)
                mcr = pikepdf.Dictionary({
                    "/Type": pikepdf.Name("/MCR"),
                    "/Pg": page_obj,
                    "/MCID": pikepdf.Integer(new_mcid),
                })
                figure = pdf.make_indirect(pikepdf.Dictionary({
                    "/Type": pikepdf.Name("/StructElem"),
                    "/S": pikepdf.Name("/Figure"),
                    "/P": document,
                    "/Pg": page_obj,
                    "/Alt": pikepdf.String(""),
                    "/K": pikepdf.Array([mcr]),
                }))
                doc_kids = ensure_struct_elem_kids_array(document, preserve_scalar=True)
                doc_kids.append(figure)
                document["/K"] = doc_kids

                # Update ParentTree.
                parent_tree, nums, page_key, current_entry = parent_tree_entry_for_page(
                    struct_root, pdf, page_obj
                )
                while len(current_entry) <= new_mcid:
                    current_entry.append(None)  # pikepdf null
                current_entry[new_mcid] = figure
                upsert_parent_tree_entry(nums, page_key, current_entry)

                changed = True
                repairs_applied += 1
                applied.append({
                    "ref": risk["ref"],
                    "before": f"untagged depth-0 image '{xobj_name}' on page {page_num}",
                    "after": f"/Figure MCID {new_mcid} with empty alt (decorative)",
                    "details": (
                        f"Wrapped depth-0 Do /{xobj_name} in BDC /MCID {new_mcid} EMC "
                        f"and created /Figure struct element on page {page_num}. "
                        f"Fixes Adobe 'Other elements alternate text' check."
                    ),
                })
            except Exception as exc:
                unresolved.append(f"Could not tag direct image {xobj_name} on page {page_num}: {exc}")
            continue

        obj = resolve_obj(pdf, risk.get("ref"))
        if not isinstance(obj, pikepdf.Dictionary):
            continue
        if mode == "mixed_text_graphics_same_mcid" and risk.get("splitSafe"):
            split_changed, split_applied, split_warnings, _ = split_safe_mixed_mcid_owner(pdf, obj, risk)
            if split_changed:
                changed = True
                repairs_applied += 1
                applied.extend(split_applied)
                unresolved.extend(split_warnings[:3])
                continue
            # Split failed despite splitSafe=True — fall through to /Alt fallback below.
            unresolved.extend(split_warnings[:3])

        if mode == "mixed_text_graphics_same_mcid":
            # Element mixes text and graphics in the same MCID and could not be split.
            # Do NOT add /Alt — adding /Alt to a non-Figure element causes Adobe's
            # "Other elements alternate text" failure. The element's text content is
            # directly readable by assistive technology via the MCID. If the graphics
            # are content-bearing (not decorative), a manual structural split is needed.
            unresolved.append(
                f"{risk['tag']} {risk['ref']} mixes text and graphics in the same MCID and "
                f"could not be split automatically. Manual remediation needed to separate "
                f"the graphic into a child /Figure element with its own /Alt."
            )
            continue

        if mode == "graphics_only_nonfigure":
            # Struct element contains only graphics but is tagged as a non-Figure element.
            # The correct structural fix is to retag as /Figure with /Alt="" (decorative).
            # Only do this for tags that are safe to retag and have no unsafe ancestry
            # (table cells, TOC items, links, etc. must stay as-is).
            tag = str(obj.get("/S", ""))
            parent_tags = risk.get("parentTagPath") or []
            has_unsafe_ancestry = any(t in UNSAFE_FIGURE_ANCESTRY for t in parent_tags)
            if tag in SAFE_FIGURE_RETAG_TAGS and not has_unsafe_ancestry:
                try:
                    obj["/S"] = pikepdf.Name("/Figure")
                    obj["/Alt"] = pikepdf.String("")
                    changed = True
                    repairs_applied += 1
                    applied.append({
                        "ref": risk["ref"],
                        "before": tag,
                        "after": "/Figure",
                        "details": (
                            f"Retagged graphics-only {tag} {risk['ref']} as /Figure with empty alt "
                            f"(decorative). Fixes Adobe 'Other elements alternate text' check."
                        ),
                    })
                except Exception as exc:
                    unresolved.append(f"Could not retag {risk['tag']} {risk['ref']} as /Figure: {exc}")
                continue
            unresolved.append(
                f"{risk['tag']} {risk['ref']} contains only graphics but is not tagged as /Figure. "
                f"Manual remediation needed: retag as /Figure with /Alt, or mark content as /Artifact."
            )
            continue

        if mode == "nonfigure_with_alt":
            # Non-Figure/non-Formula element has /Alt set with actual content kids.
            # Adobe's "Other elements alternate text" check fails for these because
            # /Alt is only valid on /Figure and /Formula elements per PDF/UA.
            # The element's text content is directly accessible via its MCIDs, so
            # /Alt is redundant and incorrect here.
            existing_alt = obj.get("/Alt")
            if existing_alt is not None:
                try:
                    del obj["/Alt"]
                    changed = True
                    repairs_applied += 1
                    applied.append({
                        "ref": risk["ref"],
                        "before": str(existing_alt)[:60],
                        "after": None,
                        "details": (
                            f"Removed /Alt from {risk['tag']} element {risk['ref']}: non-Figure elements "
                            f"must not carry /Alt (Adobe 'Other elements alternate text' check). "
                            f"The element's text content is accessible via its MCIDs."
                        ),
                    })
                except Exception as exc:
                    unresolved.append(f"Could not remove /Alt from {risk['tag']} {risk['ref']}: {exc}")
            continue

        if mode == "orphaned_alt_empty_element":
            # Element has /Alt but no MCID/OBJR-backed content. Adobe flags this as
            # "Associated with content - Failed". Remove both the /Alt AND the element
            # itself from its parent's /K array. A /Figure with no content association
            # is structurally invalid: keeping it (even without /Alt) causes veraPDF
            # clause-7.3 failures (Figure must have alt text). Deleting it entirely
            # satisfies both Adobe and veraPDF.
            elem_ref = risk["ref"]
            existing_alt = obj.get("/Alt")
            parent_ref = None
            try:
                parent_obj = obj.get("/P")
                if isinstance(parent_obj, pikepdf.Dictionary):
                    parent_ref = ref_string(parent_obj)
                    parent_kids = parent_obj.get("/K")
                    if isinstance(parent_kids, pikepdf.Array):
                        new_kids = pikepdf.Array()
                        removed = False
                        for kid in parent_kids:
                            kid_obj = kid if isinstance(kid, pikepdf.Dictionary) else (kid.get_object() if hasattr(kid, "get_object") else None)
                            if kid_obj is not None and ref_string(kid_obj) == elem_ref:
                                removed = True
                            else:
                                new_kids.append(kid)
                        if removed:
                            parent_obj["/K"] = new_kids
                            changed = True
                            repairs_applied += 1
                            applied.append({
                                "ref": elem_ref,
                                "before": str(existing_alt)[:60] if existing_alt is not None else risk["tag"],
                                "after": None,
                                "details": (
                                    f"Deleted orphaned {risk['tag']} element {elem_ref} from parent {parent_ref}: "
                                    f"element has no MCID/OBJR content association. Removing it satisfies both "
                                    f"Adobe 'Associated with content' and veraPDF clause-7.3 (Figure requires alt text)."
                                ),
                            })
                            continue
            except Exception as exc:
                unresolved.append(f"Could not delete orphaned {risk['tag']} {elem_ref} from parent: {exc}")
            # Fallback: if deletion failed (e.g., parent not found), at least strip /Alt.
            if existing_alt is not None:
                try:
                    del obj["/Alt"]
                    changed = True
                    repairs_applied += 1
                    applied.append({
                        "ref": elem_ref,
                        "before": str(existing_alt)[:60],
                        "after": None,
                        "details": (
                            f"Removed orphaned /Alt from {risk['tag']} element {elem_ref} (parent deletion failed): "
                            f"empty structure elements must not carry alternate text "
                            f"(Adobe 'Associated with content' check)."
                        ),
                    })
                except Exception as exc:
                    unresolved.append(f"Could not remove orphaned /Alt from {risk['tag']} {elem_ref}: {exc}")
            continue

        if mode in {"duplicate_mcid_ownership", "container_with_graphics_descendants"}:
            unresolved.append(f"{risk['tag']} {risk['ref']} still has duplicate graphics ownership after normalization.")
            continue
        unresolved.append(f"{risk['tag']} {risk['ref']} remains in mode {mode}.")

    if changed:
        return True, applied, unresolved[:5]
    return False, [], unresolved[:5] or ["No safe deterministic repair was available for the detected Acrobat alternate-text risks."]


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
GRAPHICS_OPERATORS = {"Do", "re", "S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "m", "l", "c", "v", "y", "h", "n"}


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


def _normalized_text_fragment(value):
    try:
        text = str(value).replace("u:", "").strip()
    except Exception:
        return ""
    if not text or text in ("None", "null"):
        return ""
    return text


def page_mcid_text_map(page_obj):
    if not isinstance(page_obj, pikepdf.Dictionary):
        return {}
    try:
        instructions = list(pikepdf.parse_content_stream(page_obj))
    except Exception:
        return {}

    text_by_mcid = {}
    mcid_stack = []

    for instruction in instructions:
        operator = str(instruction.operator)
        operands = list(instruction.operands)

        if operator == "BDC":
            mcid = None
            if len(operands) >= 2 and isinstance(operands[1], pikepdf.Dictionary):
                raw_mcid = operands[1].get("/MCID")
                try:
                    mcid = int(raw_mcid)
                except Exception:
                    mcid = None
            mcid_stack.append(mcid)
            continue
        if operator == "BMC":
            mcid_stack.append(None)
            continue
        if operator == "EMC":
            if mcid_stack:
                mcid_stack.pop()
            continue
        if operator not in TEXT_SHOWING_OPERATORS:
            continue

        active_mcid = next((value for value in reversed(mcid_stack) if value is not None), None)
        if active_mcid is None:
            continue

        fragments = [_normalized_text_fragment(value) for value in text_strings_for_instruction(instruction)]
        normalized = " ".join(fragment for fragment in fragments if fragment).strip()
        if not normalized:
            continue
        existing = text_by_mcid.get(active_mcid, "")
        text_by_mcid[active_mcid] = f"{existing} {normalized}".strip() if existing else normalized

    return text_by_mcid


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


def artifact_orphan_top_level_content_groups(pdf, page_obj, include_text_groups=False):
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

        if is_marked is False:
            has_text = group_has_text_showing(group)
            has_graphics = group_has_visible_graphics(group)
            if has_graphics or (include_text_groups and has_text):
                rewritten.append(pikepdf.ContentStreamInstruction([pikepdf.Name("/Artifact")], pikepdf.Operator("BMC")))
                rewritten.extend(group)
                rewritten.append(pikepdf.ContentStreamInstruction([], pikepdf.Operator("EMC")))
                changed = True
                kind = "text+graphics" if has_text else "graphics"
                applied.append({
                    "ref": page_ref,
                    "before": f"untagged top-level {kind}",
                    "after": "/Artifact",
                    "details": f"Marked untagged top-level {kind} group {index} on page {page_ref} as /Artifact.",
                })
                continue

        rewritten.extend(group)

    if not changed:
        return False, []

    page_obj["/Contents"] = pdf.make_stream(pikepdf.unparse_content_stream(rewritten))
    return True, applied


def untagged_top_level_content_groups(pdf, include_text_groups=False):
    groups = []
    for page_num, page in enumerate(pdf.pages, 1):
        page_obj = page.obj if hasattr(page, "obj") else page
        parsed_groups = parse_top_level_content_groups(page_obj)
        if not parsed_groups:
            continue
        page_ref = ref_string(page_obj)
        for index, (is_marked, group) in enumerate(parsed_groups):
            if is_marked is not False:
                continue
            has_text = group_has_text_showing(group)
            has_graphics = group_has_visible_graphics(group)
            if not has_graphics and not (include_text_groups and has_text):
                continue
            kind = "text+graphics" if has_text and has_graphics else "text" if has_text else "graphics"
            groups.append({
                "ref": f"{page_ref}:group:{index}",
                "pageRef": page_ref,
                "pageNumber": page_num,
                "groupIndex": index,
                "hasText": has_text,
                "hasGraphics": has_graphics,
                "kind": kind,
            })
    return groups


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


def _build_mcid_to_struct_tag(pdf, page_obj):
    """Build a mapping from MCID integer → struct element /S tag name for a given page."""
    page_objgen = getattr(page_obj, "objgen", None)
    mcid_to_tag = {}
    if page_objgen is None:
        return mcid_to_tag
    for elem in iter_struct_elems(pdf):
        try:
            pg = elem.get("/Pg")
            elem_pg = getattr(pg, "objgen", None) if pg is not None else None
            if elem_pg != page_objgen:
                continue
            tag = str(elem.get("/S", "/Span"))
            k = elem.get("/K")
            if k is None:
                continue
            try:
                mcid_to_tag[int(k)] = tag
                continue
            except Exception:
                pass
            if isinstance(k, pikepdf.Array):
                for item in k:
                    try:
                        mcid_to_tag[int(item)] = tag
                    except Exception:
                        if isinstance(item, pikepdf.Dictionary):
                            mcid_val = item.get("/MCID")
                            if mcid_val is not None:
                                try:
                                    mcid_to_tag[int(mcid_val)] = tag
                                except Exception:
                                    pass
            elif isinstance(k, pikepdf.Dictionary):
                mcid_val = k.get("/MCID")
                if mcid_val is not None:
                    try:
                        mcid_to_tag[int(mcid_val)] = tag
                    except Exception:
                        pass
        except Exception:
            continue
    return mcid_to_tag


def repair_malformed_bdc_tags_on_page(pdf, page_obj):
    """Fix BDC operators that are missing their tag-name operand.

    Some PDF generators emit `<properties_dict> BDC` instead of the required
    `/TagName <properties_dict> BDC`.  pdftoppm and other renderers reject these
    as a syntax error, causing pages to render as white and producing false-positive
    color-contrast failures.  This function patches each such instruction by
    prepending the correct tag name looked up from the struct tree, or /Span if
    the MCID cannot be found.
    """
    try:
        instructions = list(pikepdf.parse_content_stream(page_obj))
    except Exception:
        return False, []

    malformed_indices = []
    for i, inst in enumerate(instructions):
        if str(inst.operator) != "BDC":
            continue
        ops = list(inst.operands)
        # Well-formed BDC has [/TagName, properties_dict] or [/TagName, /PropsName]
        if len(ops) >= 2:
            continue
        # Single operand — should be a properties dict (malformed, missing tag name)
        if len(ops) == 1 and isinstance(ops[0], pikepdf.Dictionary):
            malformed_indices.append(i)

    if not malformed_indices:
        return False, []

    mcid_map = _build_mcid_to_struct_tag(pdf, page_obj)

    rewritten = list(instructions)
    applied_details = []
    for i in reversed(malformed_indices):
        props_dict = list(rewritten[i].operands)[0]
        mcid_val = props_dict.get("/MCID")
        try:
            mcid_int = int(mcid_val) if mcid_val is not None else None
        except Exception:
            mcid_int = None
        tag_name = mcid_map.get(mcid_int, "/Span") if mcid_int is not None else "/Span"
        rewritten[i] = pikepdf.ContentStreamInstruction(
            [pikepdf.Name(tag_name), props_dict],
            pikepdf.Operator("BDC"),
        )
        applied_details.append(f"Fixed malformed BDC at instruction {i}: prepended {tag_name} (MCID {mcid_int})")

    page_obj["/Contents"] = pdf.make_stream(pikepdf.unparse_content_stream(rewritten))
    return True, applied_details


def mutate_repair_malformed_bdc_operators(pdf, mutation):
    """Repair BDC operators missing their tag-name operand across all pages."""
    applied = []
    changed = False
    for page in pdf.pages:
        page_obj = page.obj if hasattr(page, "obj") else page
        page_changed, details = repair_malformed_bdc_tags_on_page(pdf, page_obj)
        if page_changed:
            changed = True
            for detail in details:
                applied.append({
                    "ref": ref_string(page_obj),
                    "before": "malformed BDC (1 operand)",
                    "after": "well-formed BDC (2 operands)",
                    "details": detail,
                })
    return changed, applied, []


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

    # Also fix malformed BDC operators (missing tag-name operand) which cause
    # pdftoppm and other renderers to emit syntax errors and render pages as white.
    bdc_changed, bdc_applied, _ = mutate_repair_malformed_bdc_operators(pdf, mutation)
    if bdc_changed:
        applied.extend(bdc_applied)
        changed = True

    return changed, applied, []


def mutate_repair_note_tag_ids(pdf, mutation):
    applied = []
    changed = False
    counter = 1
    role_map = {}
    struct_root = get_struct_tree_root(pdf)
    if isinstance(struct_root, pikepdf.Dictionary):
        raw_role_map = struct_root.get("/RoleMap")
        if isinstance(raw_role_map, pikepdf.Dictionary):
            role_map = raw_role_map
    for obj in iter_struct_elems(pdf):
        struct_type = obj.get("/S")
        mapped_type = role_map.get(struct_type) if struct_type is not None else None
        if str(struct_type) not in {"/Note", "/Footnote"} and str(mapped_type) != "/Note":
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
        page_kids = ensure_struct_elem_kids_array(page_elem, preserve_scalar=False)
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


def _struct_kids_list(obj):
    kids = obj.get("/K") if isinstance(obj, pikepdf.Dictionary) else None
    if isinstance(kids, pikepdf.Array):
        return list(kids)
    if kids is None:
        return []
    return [kids]


def _objr_targets_annotation(kid, annot):
    if not isinstance(kid, pikepdf.Dictionary):
        return False
    if str(kid.get("/Type", "")) != "/OBJR":
        return False
    try:
        target = kid.get("/Obj")
    except Exception:
        return False
    if not isinstance(target, pikepdf.Dictionary):
        return False
    return ref_string(target) == ref_string(annot)


def _remove_annotation_objr_from_nonlink_elems(pdf, annot):
    removed = []
    annot_ref = ref_string(annot)
    if not annot_ref:
        return removed

    for elem in iter_struct_elems(pdf):
        tag = str(elem.get("/S", ""))
        if tag == "/Link":
            continue
        kids = _struct_kids_list(elem)
        if not kids:
            continue
        kept = []
        changed = False
        for kid in kids:
            if _objr_targets_annotation(kid, annot):
                changed = True
                removed.append({
                    "ref": ref_string(elem),
                    "before": tag or "null-tag",
                    "after": "OBJR removed",
                    "details": f"Removed stale OBJR for link annotation {annot_ref} from non-/Link structure element {ref_string(elem)}.",
                })
                continue
            kept.append(kid)

        if not changed:
            continue

        if len(kept) == 0:
            try:
                del elem["/K"]
            except Exception:
                elem["/K"] = pikepdf.Array()
        elif len(kept) == 1:
            elem["/K"] = kept[0]
        else:
            elem["/K"] = pikepdf.Array(kept)

    return removed


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

            removed_objr = _remove_annotation_objr_from_nonlink_elems(pdf, annot)
            if removed_objr:
                applied.extend(removed_objr)
                changed = True

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
            # Do NOT copy /Contents to /Alt on the struct element. Struct elements
            # that only have an OBJR (no MCID content) must not carry /Alt or Adobe
            # fires "Associated with content - Failed" because /Alt requires MCID-based
            # content association. The annotation's /Contents is the accessible
            # description and is read directly by assistive technology.

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

    page_kids = ensure_struct_elem_kids_array(page_elem, preserve_scalar=False)
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

    Preserve the original PDF font subtype. These remediation flows often
    attach a fallback TrueType program to legacy simple-font dictionaries with
    custom /Encoding differences. Flipping the dictionary to /TrueType causes
    veraPDF to evaluate the original encoding as a non-symbolic TrueType
    encoding, which introduces avoidable AGL conformance failures.
    """
    data = font_path.read_bytes()
    ext = font_path.suffix.lower()
    if ext in {".ttf", ".ttc"}:
        stream = pdf.make_stream(data)
        stream["/Length1"] = len(data)
        descriptor["/FontFile2"] = stream
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


def _agl_compliant_differences(differences_array):
    """Return a cleaned /Differences array keeping only AGL-compliant glyph names.

    veraPDF rule (PDF/UA-1 via ISO 32000-1 §9.6.6.4): non-symbolic TrueType fonts
    may only define a /Differences array if every glyph name is listed in the
    Adobe Glyph List.  Names not in the AGL must be removed; if none remain the
    entire /Differences key should be deleted.

    Returns (new_array_or_None, changed: bool).
    """
    if not isinstance(differences_array, pikepdf.Array):
        return None, False

    new_items = []
    current_code = None
    pending_code = None
    pending_names = []
    any_removed = False

    def flush_pending():
        nonlocal pending_code
        if pending_code is None:
            return
        for name in pending_names:
            glyph = name.lstrip("/")
            in_agl = glyph_name_to_unicode(glyph) is not None
            if in_agl:
                if not new_items or not isinstance(new_items[-1], int):
                    new_items.append(pending_code)
                new_items.append(pikepdf.Name("/" + glyph))
            else:
                new_items  # skip — do not add
        pending_code = None
        pending_names.clear()

    temp_pending_code = None
    temp_pending_names = []

    for item in differences_array:
        if isinstance(item, int):
            # flush previous run
            if temp_pending_code is not None:
                code = temp_pending_code
                for idx, name in enumerate(temp_pending_names):
                    glyph = str(name).lstrip("/")
                    in_agl = glyph_name_to_unicode(glyph) is not None
                    if in_agl:
                        if not new_items or not isinstance(new_items[-1], int):
                            new_items.append(code + idx)
                        new_items.append(pikepdf.Name("/" + glyph))
                    else:
                        any_removed = True
            temp_pending_code = int(item)
            temp_pending_names = []
        else:
            temp_pending_names.append(str(item))

    # flush last run
    if temp_pending_code is not None:
        code = temp_pending_code
        for idx, name in enumerate(temp_pending_names):
            glyph = str(name).lstrip("/")
            in_agl = glyph_name_to_unicode(glyph) is not None
            if in_agl:
                if not new_items or not isinstance(new_items[-1], int):
                    new_items.append(code + idx)
                new_items.append(pikepdf.Name("/" + glyph))
            else:
                any_removed = True

    if not any_removed:
        return differences_array, False

    if not new_items:
        return None, True  # all entries were non-AGL — delete the key

    return pikepdf.Array(new_items), True


def normalize_font_program_subtype(font, descriptor):
    if not isinstance(font, pikepdf.Dictionary) or not isinstance(descriptor, pikepdf.Dictionary):
        return False
    if str(font.get("/Subtype")) != "/Type1":
        return False
    if descriptor.get("/FontFile2") is None:
        return False

    changed = False
    font["/Subtype"] = pikepdf.Name("/TrueType")
    changed = True

    encoding = font.get("/Encoding")
    if isinstance(encoding, pikepdf.Dictionary):
        if encoding.get("/BaseEncoding") is None:
            encoding["/BaseEncoding"] = pikepdf.Name("/WinAnsiEncoding")
            changed = True
        # Strip or clean /Differences so every remaining glyph name is AGL-compliant.
        # veraPDF requires this for non-symbolic TrueType fonts (ISO 32000-1 §9.6.6.4).
        cleaned, diff_changed = _agl_compliant_differences(encoding.get("/Differences"))
        if diff_changed:
            if cleaned is None:
                del encoding["/Differences"]
            else:
                encoding["/Differences"] = cleaned
            changed = True
    elif encoding is None:
        font["/Encoding"] = pikepdf.Name("/WinAnsiEncoding")
        changed = True

    return changed


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
        min_code = min(width_map.keys())
        max_code = max(width_map.keys())
        next_first = min(existing_first, min_code)
        next_last = max(existing_last, max_code)
        next_widths = pikepdf.Array(existing_widths)
        if next_first < existing_first:
            next_widths = pikepdf.Array([0] * (existing_first - next_first) + list(next_widths))
        if next_last > existing_last:
            next_widths.extend([0] * (next_last - existing_last))
        changed = False
        for code, width in width_map.items():
            index = code - next_first
            if index < 0 or index >= len(next_widths):
                continue
            if int(next_widths[index]) != int(width):
                next_widths[index] = int(width)
                changed = True
        if changed:
            if next_first != existing_first:
                font["/FirstChar"] = int(next_first)
            if next_last != existing_last:
                font["/LastChar"] = int(next_last)
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
    legacy_subset_match = re.fullmatch(r"[Gg]([0-9A-Fa-f]{2,4})", cleaned)
    if legacy_subset_match:
        try:
            subset_code = int(legacy_subset_match.group(1), 16)
            if 0 <= subset_code <= 0xFF:
                return bytes([subset_code]).decode("cp1252")
            if 0 <= subset_code <= 0x10FFFF and not (0xD800 <= subset_code <= 0xDFFF):
                return chr(subset_code)
        except Exception:
            return None
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


def mutate_repair_truetype_encoding_differences(pdf, mutation):
    """Remove non-AGL glyph names from /Differences arrays of TrueType fonts.

    veraPDF PDF/UA-1 rule: non-symbolic TrueType fonts may only include a
    /Differences array when every glyph name is in the Adobe Glyph List.
    This pass strips non-AGL names (or removes the array entirely) for all
    embedded TrueType fonts, resolving the 'Differences are Unicode compliant =
    false' failure without changing any visible rendering.
    """
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
            subtype = str(font.get("/Subtype"))
            if subtype != "/TrueType":
                continue
            font_ref = ref_string(font) or str(id(font))
            if font_ref in processed_refs:
                continue
            processed_refs.add(font_ref)
            encoding = font.get("/Encoding")
            if not isinstance(encoding, pikepdf.Dictionary):
                continue
            base_font = normalized_base_font_name(font.get("/BaseFont"))
            cleaned, diff_changed = _agl_compliant_differences(encoding.get("/Differences"))
            if not diff_changed:
                continue
            changed = True
            if cleaned is None:
                del encoding["/Differences"]
                applied.append({
                    "ref": font_ref,
                    "before": "/Differences",
                    "after": None,
                    "details": f"Removed non-AGL /Differences array from TrueType font {base_font}; encoding is now purely WinAnsiEncoding/MacRomanEncoding-based.",
                })
            else:
                encoding["/Differences"] = cleaned
                applied.append({
                    "ref": font_ref,
                    "before": "/Differences",
                    "after": "/Differences",
                    "details": f"Stripped non-AGL glyph names from /Differences array of TrueType font {base_font}; remaining entries are AGL-compliant.",
                })

    return changed, applied, warnings


def mutate_repair_font_unicode_maps(pdf, mutation):
    applied = []
    warnings = []
    changed = False
    processed_refs = set()
    used_codes_by_font = collect_used_codes_by_font(pdf)
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
            font_ref = ref_string(font) or str(id(font))
            if font_ref in processed_refs:
                continue
            processed_refs.add(font_ref)
            subtype = str(font.get("/Subtype"))
            encoding = str(font.get("/Encoding")) if font.get("/Encoding") is not None else ""
            descriptor = font_descriptor_for(font)
            base_font = normalized_base_font_name(font.get("/BaseFont"))
            if subtype == "/Type0" and encoding == "/Identity-H" and base_font == "/GlyphLessFont":
                used_codes = sorted(used_codes_by_font.get(font_ref, set()))
                codepoint_map = {
                    code: chr(code)
                    for code in used_codes
                    if 0 <= code <= 0x10FFFF and not (0xD800 <= code <= 0xDFFF)
                }
                if codepoint_map:
                    existing_map = parse_tounicode_map(font.get("/ToUnicode"))
                    merged_map = {**existing_map, **codepoint_map}
                    if merged_map != existing_map:
                        font["/ToUnicode"] = pdf.make_stream(build_cid_tounicode_cmap(merged_map).encode("utf-8"))
                        applied.append({
                            "ref": ref_string(font),
                            "before": "/ToUnicode" if existing_map else None,
                            "after": "/ToUnicode",
                            "details": f"{'Extended' if existing_map else 'Added'} a CID ToUnicode CMap for {base_font} using {len(codepoint_map)} OCR glyph code mappings.",
                        })
                        changed = True
                    continue
                warnings.append(f"Could not derive a ToUnicode map for {base_font} ({subtype}, {encoding or 'no encoding'}).")
                continue
            if has_tounicode(font):
                continue
            if subtype == "/TrueType" and isinstance(font.get("/Encoding"), pikepdf.Dictionary):
                derived_map = font_encoding_map(font)
                used_codes = sorted(used_codes_by_font.get(font_ref, set()))
                if used_codes:
                    derived_map = {code: text for code, text in derived_map.items() if code in used_codes}
                if derived_map and merge_tounicode_map(font, pdf, derived_map):
                    applied.append({
                        "ref": ref_string(font),
                        "before": None,
                        "after": "/ToUnicode",
                        "details": (
                            f"Added a ToUnicode CMap for {base_font} using the font's "
                            f"BaseEncoding plus AGL-compliant /Differences mappings."
                        ),
                    })
                    changed = True
                    continue
            if subtype != "/TrueType" or encoding not in {"/WinAnsiEncoding", "/MacRomanEncoding"}:
                explicit_map = SIMPLE_TRUETYPE_UNICODE_MAPS.get(base_font, {})
                used_codes = sorted(used_codes_by_font.get(font_ref, set()))
                if explicit_map:
                    full_explicit_map = explicit_map
                    if used_codes:
                        explicit_map = {code: text for code, text in explicit_map.items() if code in used_codes}
                    if (
                        not explicit_map
                        and subtype == "/Type0"
                        and encoding == "/Identity-H"
                        and used_codes == [0]
                    ):
                        # Some legacy Type0 symbol subsets collapse all live glyph references to CID 0
                        # even when the deterministic fallback map is known. Preserve the fallback map
                        # so the font still receives a standards-valid ToUnicode stream.
                        explicit_map = full_explicit_map
                    if explicit_map:
                        substitute_name = SIMPLE_TRUETYPE_SUBSTITUTE_FONTS.get(base_font)
                        substitute_path = font_file_path(substitute_name) if substitute_name else None
                        if substitute_path and isinstance(descriptor, pikepdf.Dictionary):
                            embed_font_program(pdf, descriptor, substitute_path, font=font)
                            changed = True
                            applied.append({
                                "ref": ref_string(font),
                                "before": base_font,
                                "after": substitute_name,
                                "details": f"Embedded a full substitute font program for legacy symbol font {base_font} using {substitute_path.name}.",
                            })
                            cache_key = str(substitute_path)
                            metrics = metrics_cache.get(cache_key)
                            if metrics is None:
                                metrics = parse_ttf_metrics(substitute_path)
                                metrics_cache[cache_key] = metrics
                            if metrics:
                                width_map = derive_width_map(metrics, explicit_map)
                                if width_map and update_font_widths(font, width_map):
                                    changed = True
                                    applied.append({
                                        "ref": ref_string(font),
                                        "before": "/Widths",
                                        "after": f"{len(width_map)} width entries",
                                        "details": f"Updated width entries for {base_font} from the substitute font metrics in {substitute_path.name}.",
                                    })
                        if merge_tounicode_map(font, pdf, explicit_map):
                            applied.append({
                                "ref": ref_string(font),
                                "before": None,
                                "after": "/ToUnicode",
                                "details": f"Added an explicit ToUnicode CMap for legacy symbol font {base_font} using {len(explicit_map)} deterministic character mappings.",
                            })
                            changed = True
                        if ensure_explicit_truetype_encoding(font, base_font):
                            changed = True
                            applied.append({
                                "ref": ref_string(font),
                                "before": None,
                                "after": "/Encoding",
                                "details": f"Added an explicit WinAnsi-based encoding profile for {base_font} to keep the substitute TrueType font validator-compliant.",
                            })
                        if normalize_symbolic_flags_for_unicode_substitute(descriptor):
                            changed = True
                            applied.append({
                                "ref": ref_string(descriptor) or ref_string(font),
                                "before": None,
                                "after": "/Flags 32",
                                "details": f"Normalized font descriptor flags for {base_font} to a non-symbolic substitute profile after explicit Unicode recovery.",
                            })
                        continue
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
            descriptor = font_descriptor_for(font)
            if isinstance(descriptor, pikepdf.Dictionary) and descriptor.get("/CharSet") is not None:
                try:
                    del descriptor["/CharSet"]
                    applied.append({
                        "ref": ref_string(font),
                        "before": "/CharSet",
                        "after": "removed",
                        "details": f"Removed invalid /CharSet entry from Type1/Type3 font descriptor for {str(font.get('/BaseFont'))}.",
                    })
                    changed = True
                except Exception:
                    warnings.append(f"Could not remove /CharSet from {str(font.get('/BaseFont'))}.")
            if has_tounicode(font):
                continue

            base_font = str(font.get("/BaseFont"))
            encoding_map = font_encoding_map(font)
            explicit_subset_map = TYPE1_SUBSET_UNICODE_MAPS.get(base_font, {})
            encoding_map.update(explicit_subset_map)
            used_codes = sorted(used_codes_by_font.get(font_ref, set()))
            if used_codes:
                encoding_map = {code: text for code, text in encoding_map.items() if code in used_codes}
            if explicit_subset_map:
                encoding_map.update(explicit_subset_map)

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


def mutate_repair_reported_font_widths(pdf, mutation):
    applied = []
    warnings = []
    changed = False
    repairs = mutation.get("reportedWidthFixes") or []
    if not isinstance(repairs, list) or not repairs:
        return False, [], ["No reported font-width fixes were provided."]

    repair_map = {}
    for entry in repairs:
        if not isinstance(entry, dict):
            continue
        font_name = normalized_base_font_name(entry.get("fontName"))
        try:
            code = int(entry.get("code"))
            width = int(entry.get("width"))
        except Exception:
            continue
        if not font_name:
            continue
        repair_map.setdefault(font_name, {})[code] = width

    if not repair_map:
        return False, [], ["No valid reported font-width fixes were provided."]

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

            base_font = normalized_base_font_name(font.get("/BaseFont"))
            width_map = repair_map.get(base_font)
            if not width_map:
                continue
            if update_font_widths(font, width_map):
                changed = True
                applied.append({
                    "ref": ref_string(font),
                    "before": "/Widths",
                    "after": f"{len(width_map)} reported width fixes",
                    "details": f"Patched {len(width_map)} reported glyph width mismatches for {base_font} from validator findings.",
                })
            else:
                warnings.append(f"Validator-reported width fixes for {base_font} did not change the declared /Widths array.")

    if not changed and not warnings:
        warnings.append("No fonts matched the reported width-fix payload.")
    return changed, applied, warnings


def mutate_normalize_annotation_tab_order(pdf, mutation):
    """Set /Tabs /S on every page in a tagged PDF and reorder annotated pages top-to-bottom.

    Adobe Acrobat's Accessibility Checker reports 'Tab order - Failed' when any page
    in a tagged document lacks /Tabs /S (PDF/UA-1 clause 7.20 applies to all pages,
    not just annotated ones).
    """
    catalog = get_catalog(pdf)
    is_tagged = False
    if isinstance(catalog, pikepdf.Dictionary):
        mark_info = catalog.get("/MarkInfo")
        if isinstance(mark_info, pikepdf.Dictionary):
            marked = mark_info.get("/Marked")
            is_tagged = bool(marked) and str(marked) != "false"
    if not is_tagged:
        is_tagged = isinstance(get_struct_tree_root(pdf), pikepdf.Dictionary)

    applied = []
    changed = False
    for page in pdf.pages:
        page_obj = page.obj
        annots_raw = page_obj.get("/Annots")
        # Resolve indirect reference to the annotation array if needed
        if isinstance(annots_raw, pikepdf.Object) and not isinstance(annots_raw, pikepdf.Array):
            try:
                annots_raw = annots_raw.obj if hasattr(annots_raw, 'obj') else annots_raw
            except Exception:
                pass
        has_annots = isinstance(annots_raw, pikepdf.Array) and len(annots_raw) > 0

        if not has_annots and not is_tagged:
            continue

        tabs_val = page_obj.get("/Tabs")
        if tabs_val is None or str(tabs_val) != "/S":
            page_obj["/Tabs"] = pikepdf.Name("/S")
            changed = True
            applied.append({
                "ref": ref_string(page_obj),
                "before": str(tabs_val) if tabs_val is not None else None,
                "after": "/Tabs /S",
                "details": f"Normalized page tab order to /S for {ref_string(page_obj)} ({'annotated' if has_annots else 'tagged document'}).",
            })

        if has_annots:
            annots = annots_raw
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


def mutate_set_tabs_all_annotated_pages(pdf, mutation):
    """Set /Tabs /S on every page in a tagged PDF, unconditionally.

    Adobe Acrobat's Accessibility Checker fires 'Tab order - Failed' when any page
    in a tagged document lacks /Tabs /S -- this applies to ALL pages, not only those
    with annotations.  PDF/UA-1 (ISO 14289-1) clause 7.20 requires that the /Tabs
    entry in every page dictionary has the value /S when the document is tagged.

    Unlike normalize_annotation_tab_order this does not reorder annotations,
    making it safe to run as a final cleanup pass.
    """
    catalog = get_catalog(pdf)
    is_tagged = False
    if isinstance(catalog, pikepdf.Dictionary):
        mark_info = catalog.get("/MarkInfo")
        if isinstance(mark_info, pikepdf.Dictionary):
            marked = mark_info.get("/Marked")
            is_tagged = bool(marked) and str(marked) != "false"
    # Also treat as tagged when a StructTreeRoot is present — some PDFs have a struct
    # tree without /MarkInfo/Marked being set, and Adobe Acrobat's 'Tab order - Failed'
    # check applies to any page in a document that contains structure.
    if not is_tagged:
        is_tagged = isinstance(get_struct_tree_root(pdf), pikepdf.Dictionary)

    applied = []
    changed = False
    for page in pdf.pages:
        page_obj = page.obj
        tabs_val = page_obj.get("/Tabs")
        # Set /Tabs /S if:
        #  - The page has annotations, OR
        #  - The document is tagged (PDF/UA requires /Tabs /S on all pages in tagged docs)
        has_annots = False
        annots_raw = page_obj.get("/Annots")
        if isinstance(annots_raw, pikepdf.Object) and not isinstance(annots_raw, pikepdf.Array):
            try:
                annots_raw = annots_raw.obj if hasattr(annots_raw, 'obj') else annots_raw
            except Exception:
                pass
        if isinstance(annots_raw, pikepdf.Array) and len(annots_raw) > 0:
            has_annots = True

        if not has_annots and not is_tagged:
            continue

        if tabs_val is None or str(tabs_val) != "/S":
            page_obj["/Tabs"] = pikepdf.Name("/S")
            changed = True
            applied.append({
                "ref": ref_string(page_obj),
                "before": str(tabs_val) if tabs_val is not None else None,
                "after": "/Tabs /S",
                "details": f"Set /Tabs /S on page {ref_string(page_obj)} ({'annotated' if has_annots else 'tagged document'}).",
            })
    return changed, applied, []


# Annotation subtypes that Adobe's checker expects to have accessible content
_VISIBLE_ANNOT_SUBTYPES = {
    "/Link", "/Widget", "/Screen", "/Movie", "/Sound",
    "/FileAttachment", "/Stamp", "/FreeText", "/Highlight",
    "/Underline", "/Squiggly", "/StrikeOut", "/Ink", "/Popup",
}


def _annotation_is_invisible(annot):
    """Return True if the annotation is invisible/hidden and can be skipped."""
    flags = annot.get("/F")
    if isinstance(flags, int):
        invisible = (flags & 1)   # bit 1 = Invisible
        hidden = (flags & 2)      # bit 2 = Hidden
        no_view = (flags & 32)    # bit 6 = NoView
        if invisible or hidden or no_view:
            return True
    return False


def mutate_repair_annotation_alt_text(pdf, mutation):
    """Ensure all visible annotations have accessible descriptions.

    Adobe Accessibility Checker reports two failures for annotations without
    accessible text:
      - 'Associated with content - Failed': the annotation is not linked into
        the document's structure tree via a /StructParent back-reference.
      - 'Other elements alternate text - Failed': a non-link annotation lacks
        a /Contents entry (the tooltip/alt text that assistive technology reads).

    This operation:
    1. Ensures every visible, non-link annotation has a /Contents entry.
       - Links already have their text from the visible link text or URL.
       - For other annotation types we synthesise a description from the
         annotation's existing /T (title), /Contents, subtype, or a generic
         fallback so screen readers have something to announce.
    2. For every annotation that already has a /Contents entry, ensures
       the string is non-empty (replaces blank entries with a generic label).
    3. Sets /Tabs /S on every page that has annotations (covers the
       'Tab order - Failed' Adobe check for non-link annotations that the
       set_page_tabs tool misses because it only targets pages with links).
    """
    applied = []
    warnings = []
    changed = False

    subtype_labels = {
        "/Stamp": "Stamp",
        "/FreeText": "Text annotation",
        "/Highlight": "Highlighted text",
        "/Underline": "Underlined text",
        "/Squiggly": "Squiggly underline",
        "/StrikeOut": "Strikethrough",
        "/Ink": "Ink annotation",
        "/Sound": "Sound annotation",
        "/Movie": "Movie annotation",
        "/FileAttachment": "File attachment",
        "/Screen": "Screen annotation",
        "/Widget": "Form field",
        "/Popup": "Popup note",
    }

    # Determine if document is tagged (PDF/UA requires /Tabs /S on all pages)
    catalog = get_catalog(pdf)
    is_tagged = False
    if isinstance(catalog, pikepdf.Dictionary):
        mark_info = catalog.get("/MarkInfo")
        if isinstance(mark_info, pikepdf.Dictionary):
            marked = mark_info.get("/Marked")
            is_tagged = bool(marked) and str(marked) != "false"

    # Set up parent tree access for /StructParent repairs on non-Link annotations.
    # Adobe fires 'Associated with content - Failed' when a visible annotation in a
    # tagged document lacks a /StructParent back-reference into the parent tree.
    struct_root = None
    struct_document = None
    struct_nums = None
    struct_next_key = 0
    if is_tagged:
        struct_root = get_struct_tree_root(pdf)
        if isinstance(struct_root, pikepdf.Dictionary):
            struct_document = ensure_document_struct_elem(pdf, struct_root)
            _, struct_nums = ensure_parent_tree(struct_root, pdf)
            struct_next_key = int(struct_root.get("/ParentTreeNextKey", 0) or 0)

    for page in pdf.pages:
        page_obj = page.obj
        annots_raw = page_obj.get("/Annots")
        # Resolve indirect reference to annotation array if needed
        if isinstance(annots_raw, pikepdf.Object) and not isinstance(annots_raw, pikepdf.Array):
            try:
                annots_raw = annots_raw.obj if hasattr(annots_raw, 'obj') else annots_raw
            except Exception:
                pass
        has_annots = isinstance(annots_raw, pikepdf.Array) and len(annots_raw) > 0
        annots = annots_raw if has_annots else pikepdf.Array()

        # Fix tab order: PDF/UA requires /Tabs /S on all pages in a tagged doc.
        # Adobe fires 'Tab order - Failed' on any page missing this, with or without annotations.
        if has_annots or is_tagged:
            tabs_val = page_obj.get("/Tabs")
            if tabs_val is None or str(tabs_val) != "/S":
                page_obj["/Tabs"] = pikepdf.Name("/S")
                changed = True
                applied.append({
                    "ref": ref_string(page_obj),
                    "before": str(tabs_val) if tabs_val is not None else None,
                    "after": "/Tabs /S",
                    "details": f"Set /Tabs /S on page {ref_string(page_obj)} ({'annotated' if has_annots else 'tagged document, PDF/UA clause 7.20'}).",
                })

        if not has_annots:
            continue

        for annot_ref in annots:
            try:
                # Resolve indirect object references to get the annotation dict
                annot = pdf.get_object(annot_ref.objgen) if hasattr(annot_ref, 'objgen') else annot_ref
                if not isinstance(annot, pikepdf.Dictionary):
                    continue
            except Exception:
                try:
                    annot = annot_ref
                    if not isinstance(annot, pikepdf.Dictionary):
                        continue
                except Exception:
                    continue

            subtype = str(annot.get("/Subtype") or "")
            if subtype not in _VISIBLE_ANNOT_SUBTYPES:
                continue
            if _annotation_is_invisible(annot):
                continue
            # Links are handled by set_link_annotation_contents; skip them here
            if subtype == "/Link":
                continue

            existing_contents = annot.get("/Contents")
            existing_text = ""
            if existing_contents is not None:
                try:
                    existing_text = str(existing_contents).strip()
                except Exception:
                    existing_text = ""

            if not existing_text:
                # Build a description from available fields
                title = ""
                try:
                    t = annot.get("/T")
                    if t is not None:
                        title = str(t).strip()
                except Exception:
                    pass

                label = subtype_labels.get(subtype, subtype.lstrip("/") + " annotation")
                description = title if title else label

                try:
                    annot["/Contents"] = pikepdf.String(description)
                    changed = True
                    applied.append({
                        "ref": ref_string(annot),
                        "before": None,
                        "after": f"/Contents '{description}'",
                        "details": f"Added /Contents alt text '{description}' to {subtype} annotation (required for Adobe 'Other elements alternate text' accessibility check).",
                    })
                except Exception as exc:
                    warnings.append(f"Could not set /Contents on {subtype} annotation: {exc}")

            # In tagged documents, non-Link annotations must have a /StructParent
            # back-reference into the parent tree or Adobe fires 'Associated with
            # content - Failed'. We create a minimal /Annot struct element and OBJR
            # reference so the annotation is properly linked into the structure tree.
            if is_tagged and struct_nums is not None and struct_document is not None:
                existing_struct_parent = annot.get("/StructParent")
                if existing_struct_parent is None:
                    try:
                        contents_val = annot.get("/Contents")
                        contents_str = str(contents_val).strip() if contents_val is not None else ""

                        objr = pdf.make_indirect(pikepdf.Dictionary({
                            "/Type": pikepdf.Name("/OBJR"),
                            "/Obj": annot,
                            "/Pg": page_obj,
                        }))
                        # Do NOT set /Alt on this struct element. Elements with only
                        # an OBJR (no MCID content) must not carry /Alt or Adobe fires
                        # "Associated with content - Failed". The annotation's /Contents
                        # is the accessible description; the struct element just provides
                        # the parent-tree back-reference for tagged-PDF association.
                        annot_elem = pdf.make_indirect(pikepdf.Dictionary({
                            "/Type": pikepdf.Name("/StructElem"),
                            "/S": pikepdf.Name("/Annot"),
                            "/P": struct_document,
                            "/Pg": page_obj,
                            "/K": objr,
                        }))

                        kids = struct_document.get("/K")
                        if not isinstance(kids, pikepdf.Array):
                            kids = pikepdf.Array([kids]) if kids is not None else pikepdf.Array()
                        kids.append(annot_elem)
                        struct_document["/K"] = kids

                        annot["/StructParent"] = pikepdf.Integer(struct_next_key)
                        upsert_parent_tree_entry(struct_nums, struct_next_key, annot_elem)
                        struct_next_key += 1
                        changed = True
                        applied.append({
                            "ref": ref_string(annot),
                            "before": None,
                            "after": f"/StructParent {struct_next_key - 1}",
                            "details": f"Added /StructParent and /Annot struct element for {subtype} annotation to fix Adobe 'Associated with content' accessibility check.",
                        })
                    except Exception as exc:
                        warnings.append(f"Could not add /StructParent to {subtype} annotation: {exc}")

    if struct_root is not None and isinstance(struct_root, pikepdf.Dictionary):
        struct_root["/ParentTreeNextKey"] = pikepdf.Integer(struct_next_key)

    return changed, applied, warnings


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


def _get_valid_mcids_from_stream(page_obj):
    """Return the set of integer MCIDs that have a BDC /MCID N block in the content stream."""
    try:
        raw = page_content_bytes(page_obj)
        if not raw:
            return set()
        instructions = pikepdf.parse_content_stream(page_obj)
    except Exception:
        return set()
    valid = set()
    for operands, operator in instructions:
        if str(operator) == "BDC" and len(operands) >= 2:
            props = operands[1]
            if isinstance(props, pikepdf.Dictionary):
                mcid = props.get("/MCID")
                if mcid is not None:
                    try:
                        valid.add(int(mcid))
                    except Exception:
                        pass
    return valid


def _cleanup_floating_mcid_refs(pdf, page_obj, valid_mcids):
    """
    After Artifact-wrapping, struct elements that carried integer /K MCIDs for
    content now moved under /Artifact no longer have corresponding BDC blocks.
    Acrobat validates those references and raises "error on the page" when they
    are missing.  This function finds every struct element whose /Pg matches
    page_obj and whose /K is a plain integer not in valid_mcids, then removes
    that dangling reference.
    """
    page_objgen = getattr(page_obj, "objgen", None)
    if page_objgen is None:
        return False

    changed = False
    for elem in iter_struct_elems(pdf):
        try:
            pg = elem.get("/Pg")
            elem_objgen = getattr(pg, "objgen", None) if pg is not None else None
            if elem_objgen != page_objgen:
                continue
            k = elem.get("/K")
            if k is None:
                continue
            # Plain integer /K — check if it's orphaned
            if isinstance(k, int):
                if k not in valid_mcids:
                    del elem["/K"]
                    changed = True
                continue
            # pikepdf wraps integers as pikepdf.Integer
            try:
                k_int = int(k)
                is_int = True
            except Exception:
                is_int = False
            if is_int:
                if k_int not in valid_mcids:
                    del elem["/K"]
                    changed = True
                continue
            # Array /K — remove individual integer entries that are orphaned
            if isinstance(k, pikepdf.Array):
                keep = []
                array_changed = False
                for item in k:
                    try:
                        item_int = int(item)
                        if item_int in valid_mcids:
                            keep.append(item)
                        else:
                            array_changed = True
                    except Exception:
                        keep.append(item)
                if array_changed:
                    if keep:
                        elem["/K"] = pikepdf.Array(keep)
                    else:
                        del elem["/K"]
                    changed = True
        except Exception:
            continue
    return changed


def mutate_artifact_nonsemantic_page_elements(pdf, mutation):
    # Only proceed when the document has a struct tree – that means bootstrap has
    # already run and the accessible structure is in place.  Without a struct tree,
    # marking every content item as Artifact would strip accessibility entirely.
    root = get_struct_tree_root(pdf)
    has_struct = isinstance(root, pikepdf.Dictionary)

    applied = []
    changed = False
    for page in pdf.pages:
        page_obj = page.obj if hasattr(page, "obj") else page
        try:
            raw = page_content_bytes(page_obj)
            if not raw:
                continue
        except Exception:
            continue
        # When there is a struct tree, process every page (including pages without
        # existing BDC blocks) so all top-level untagged content gets an Artifact
        # wrapper.  Without a struct tree, only fix pages that already have some
        # marked content to avoid hiding otherwise-accessible text.
        text = raw.decode("latin-1", "ignore")
        if not has_struct and "BMC" not in text and "BDC" not in text:
            continue
        page_changed, page_applied = artifact_orphan_top_level_content_groups(pdf, page_obj, include_text_groups=True)
        if page_changed:
            applied.extend(page_applied)
            changed = True
            # After rewriting the content stream, clean up any struct-element /K
            # references that point to MCIDs no longer present as BDC blocks.
            # Bootstrap creates heading elements with integer /K values (floating
            # MCIDs) that become orphaned once their content is wrapped as Artifact.
            # Adobe Acrobat validates these references and shows "error on the page"
            # when any /K MCID is missing from the content stream.
            valid_mcids = _get_valid_mcids_from_stream(page_obj)
            _cleanup_floating_mcid_refs(pdf, page_obj, valid_mcids)
    return changed, applied, []


def mutate_embed_missing_fonts_in_place(pdf, mutation):
    applied = []
    warnings = []
    changed = False
    embedded = {}
    metrics_cache = {}
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
            descriptor = font_descriptor_for(font)
            if not isinstance(descriptor, pikepdf.Dictionary):
                continue
            if descriptor.get("/FontFile") or descriptor.get("/FontFile2") or descriptor.get("/FontFile3"):
                continue
            base_font = str(font.get("/BaseFont"))
            font_path = font_file_path(base_font)
            fallback_name = None
            fallback_width_map = None
            fallback_score = None
            if not font_path and subtype == "/TrueType":
                fallback_name, font_path, fallback_width_map, fallback_score = best_embeddable_fallback_for_font(font, metrics_cache)
            if not font_path:
                fallback_name = legacy_substitute_font_name(base_font)
                font_path = font_file_path(fallback_name) if fallback_name else None
                if font_path:
                    font_ref = ref_string(font) or str(id(font))
                    encoding_map, glyph_name_map, used_codes = derive_encoding_map_for_used_codes(font, font_ref, used_codes_by_font)
                    if used_codes:
                        cache_key = str(font_path)
                        metrics = metrics_cache.get(cache_key)
                        if metrics is None:
                            metrics = parse_ttf_metrics(font_path)
                            metrics_cache[cache_key] = metrics
                        if metrics and encoding_map:
                            fallback_width_map = derive_width_map(metrics, encoding_map, glyph_name_map)
            if not font_path:
                font_ref = ref_string(font) or str(id(font))
                used_codes = sorted(used_codes_by_font.get(font_ref, set()))
                if used_codes and set(used_codes).issubset({32}):
                    fallback_name = "/ArialMT"
                    font_path = font_file_path(fallback_name)
                    if font_path:
                        cache_key = str(font_path)
                        metrics = metrics_cache.get(cache_key)
                        if metrics is None:
                            metrics = parse_ttf_metrics(font_path)
                            metrics_cache[cache_key] = metrics
                        if metrics:
                            encoding_map, glyph_name_map, _ = derive_encoding_map_for_used_codes(font, font_ref, used_codes_by_font)
                            fallback_width_map = derive_width_map(metrics, encoding_map, glyph_name_map) if encoding_map else None
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
            if fallback_width_map:
                update_font_widths(font, fallback_width_map)
            applied.append({
                "ref": ref_string(font),
                "before": base_font,
                "after": str(font_path),
                "details": (
                    f"Embedded font program for {base_font} from {font_path.name}."
                    if not fallback_name
                    else f"Embedded heuristic fallback font program for {base_font} using {fallback_name} from {font_path.name}."
                    + (f" Max width drift was {fallback_score:.3f}." if fallback_score is not None else "")
                ),
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


def derive_declared_encoding_map(font):
    encoding_map = font_encoding_map(font)
    glyph_name_map = font_encoding_glyph_names(font)
    first_char = font.get("/FirstChar")
    last_char = font.get("/LastChar")
    widths = font.get("/Widths")
    if isinstance(first_char, int) and isinstance(last_char, int) and isinstance(widths, pikepdf.Array):
        declared_codes = {
            code
            for code in range(first_char, last_char + 1)
            if (code - first_char) < len(widths)
        }
        encoding_map = {code: text for code, text in encoding_map.items() if code in declared_codes}
        glyph_name_map = {code: name for code, name in glyph_name_map.items() if code in declared_codes}
    return encoding_map, glyph_name_map


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


def best_embeddable_fallback_for_font(font, metrics_cache, max_width_drift=0.35):
    encoding_map, glyph_name_map = derive_declared_encoding_map(font)
    if not encoding_map:
        encoding_map = font_encoding_map(font)
        glyph_name_map = font_encoding_glyph_names(font)
    if not encoding_map:
        return None, None, None, None

    best_name = None
    best_path = None
    best_width_map = None
    best_score = None
    for candidate_name in HEURISTIC_SUBSET_FALLBACKS:
        candidate_path = font_file_path(candidate_name)
        if not candidate_path:
            continue
        cache_key = str(candidate_path)
        metrics = metrics_cache.get(cache_key)
        if metrics is None:
            metrics = parse_ttf_metrics(candidate_path)
            metrics_cache[cache_key] = metrics
        if not metrics:
            continue
        width_map = derive_width_map(metrics, encoding_map, glyph_name_map)
        if not width_map:
            continue
        drifts = width_drift_ratio(font, width_map)
        score = max(drifts) if drifts else 0
        if score > max_width_drift:
            continue
        if best_score is None or score < best_score:
            best_name = candidate_name
            best_path = candidate_path
            best_width_map = width_map
            best_score = score

    return best_name, best_path, best_width_map, best_score


def merge_tounicode_map(font, pdf, encoding_map):
    if not encoding_map:
        return False
    existing = parse_tounicode_map(font.get("/ToUnicode"))
    merged = {**existing, **encoding_map}
    if merged == existing and has_tounicode(font):
        return False
    subtype = str(font.get("/Subtype"))
    encoding = str(font.get("/Encoding")) if font.get("/Encoding") is not None else ""
    if subtype == "/Type0" and encoding == "/Identity-H":
        cmap = build_cid_tounicode_cmap(merged)
    else:
        cmap = build_tounicode_cmap(merged)
    font["/ToUnicode"] = pdf.make_stream(cmap.encode("utf-8"))
    return True


def normalize_symbolic_flags_for_unicode_substitute(descriptor):
    if not isinstance(descriptor, pikepdf.Dictionary):
        return False
    try:
        flags = int(descriptor.get("/Flags") or 0)
    except Exception:
        flags = 0
    desired = (flags | 32) & ~4
    if desired == flags:
        return False
    descriptor["/Flags"] = pikepdf.Integer(desired)
    return True


def ensure_explicit_truetype_encoding(font, base_font):
    if not isinstance(font, pikepdf.Dictionary):
        return False
    differences = SIMPLE_TRUETYPE_ENCODING_DIFFERENCES.get(base_font)
    if not differences:
        return False
    desired = pikepdf.Dictionary({
        "/BaseEncoding": pikepdf.Name("/WinAnsiEncoding"),
        "/Differences": pikepdf.Array(differences),
    })
    encoding = font.get("/Encoding")
    if isinstance(encoding, pikepdf.Dictionary):
        same_base = str(encoding.get("/BaseEncoding")) == "/WinAnsiEncoding"
        same_differences = list(encoding.get("/Differences") or []) == list(desired["/Differences"])
        if same_base and same_differences:
            return False
        encoding["/BaseEncoding"] = pikepdf.Name("/WinAnsiEncoding")
        encoding["/Differences"] = desired["/Differences"]
        return True
    if str(encoding) == "/WinAnsiEncoding" and base_font != "/Symbol":
        return False
    font["/Encoding"] = desired
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

    width_changed, width_applied, width_warnings = mutate_repair_reported_font_widths(pdf, mutation)
    if width_changed:
        changed = True
        applied.extend(width_applied)
    warnings.extend(width_warnings if width_changed or width_applied else [])

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

            explicit_subset_map = TYPE1_SUBSET_UNICODE_MAPS.get(base_font, {})
            if explicit_subset_map and merge_tounicode_map(font, pdf, explicit_subset_map):
                changed = True
                applied.append({
                    "ref": ref_string(font),
                    "before": None,
                    "after": "/ToUnicode",
                    "details": f"Applied explicit Unicode mappings for {base_font} from deterministic subset-font overrides.",
                })

            used_encoding_map, _, used_codes = derive_encoding_map_for_used_codes(font, font_ref, used_codes_by_font)
            width_encoding_map, width_glyph_name_map = derive_declared_encoding_map(font)
            if not used_encoding_map and has_tounicode(font):
                existing_map = parse_tounicode_map(font.get("/ToUnicode"))
                if used_codes:
                    used_encoding_map = {code: text for code, text in existing_map.items() if code in used_codes}
                else:
                    used_encoding_map = existing_map
            if not width_encoding_map and used_encoding_map:
                width_encoding_map = dict(used_encoding_map)

            if metrics and width_encoding_map:
                width_map = derive_width_map(metrics, width_encoding_map, width_glyph_name_map)
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

            if used_encoding_map:
                if merge_tounicode_map(font, pdf, used_encoding_map):
                    changed = True
                    applied.append({
                        "ref": ref_string(font),
                        "before": None,
                        "after": "/ToUnicode",
                        "details": f"Finalized ToUnicode mappings for {base_font} using {len(used_encoding_map)} used character codes.",
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
    candidate_text = str(mutation.get("text") or "").strip()
    before_alt = obj.get("/Alt")
    before_alt_text = str(before_alt).replace("u:", "") if before_alt is not None else None
    if before == after and (not candidate_text or before_alt_text == candidate_text):
        return False, [], [f"Target {target_ref} is already tagged as {after}."]
    obj["/S"] = pikepdf.Name(after)
    if before_alt is not None:
        try:
            del obj["/Alt"]
        except Exception:
            pass
    applied = [{
        "ref": ref_string(obj),
        "before": before_alt_text or before,
        "after": after,
        "details": f"Retagged structural candidate {ref_string(obj)} from {before} to {after}.",
    }]
    return True, applied, []


def mutate_normalize_heading_hierarchy(pdf, mutation):
    heading_nodes = []
    for obj in iter_struct_elems(pdf):
        tag = str(obj.get("/S"))
        if heading_level_number(tag) is None:
            continue
        heading_nodes.append(obj)

    if not heading_nodes:
        return False, [], ["No heading tags were found in the structure tree."]

    applied = []
    normalized_levels_by_ref = {}
    sibling_levels_by_parent_ref = {}

    for obj in heading_nodes:
        obj_ref = ref_string(obj)
        parent = obj.get("/P") if isinstance(obj.get("/P"), pikepdf.Dictionary) else None
        parent_ref = ref_string(parent) if isinstance(parent, pikepdf.Dictionary) else None
        normalized_level = None

        if parent_ref and parent_ref in sibling_levels_by_parent_ref:
            normalized_level = sibling_levels_by_parent_ref[parent_ref]
        else:
            ancestor = parent
            ancestor_level = None
            while isinstance(ancestor, pikepdf.Dictionary):
                ancestor_ref = ref_string(ancestor)
                if ancestor_ref and ancestor_ref in normalized_levels_by_ref:
                    ancestor_level = normalized_levels_by_ref[ancestor_ref]
                    break
                direct_level = heading_level_number(ancestor.get("/S"))
                if direct_level is not None:
                    ancestor_level = direct_level
                    break
                ancestor = ancestor.get("/P") if isinstance(ancestor.get("/P"), pikepdf.Dictionary) else None

            if ancestor_level is None:
                normalized_level = 1
            else:
                normalized_level = min(6, max(1, ancestor_level + 1))

        if obj_ref:
            normalized_levels_by_ref[obj_ref] = normalized_level
        if parent_ref:
            sibling_levels_by_parent_ref[parent_ref] = normalized_level

        before = str(obj.get("/S"))
        after = f"/H{normalized_level}"
        if before == after:
            continue
        obj["/S"] = pikepdf.Name(after)
        applied.append({
            "ref": obj_ref,
            "before": before,
            "after": after,
            "details": f"Normalized heading level for {obj_ref} from {before} to {after}.",
        })

    if not applied:
        return False, [], ["Heading hierarchy is already normalized."]
    return True, applied, []


def mutate_set_link_annotation_contents(pdf, mutation):
    page_number = int(mutation.get("pageNumber") or 0)
    annotation_index = mutation.get("annotationIndex")
    contents = str(mutation.get("contents") or "").strip()
    if page_number < 1 or annotation_index is None or not contents:
        return False, [], ["set_link_annotation_contents requires pageNumber, annotationIndex, and non-empty contents."]

    try:
        target_link_index = int(annotation_index)
    except Exception:
        return False, [], ["set_link_annotation_contents requires a numeric annotationIndex."]

    if page_number > len(pdf.pages):
        return False, [], [f"Page {page_number} is out of range for set_link_annotation_contents."]

    page = pdf.pages[page_number - 1]
    annots = page.obj.get("/Annots")
    if not isinstance(annots, pikepdf.Array):
        return False, [], [f"Page {page_number} has no annotations for set_link_annotation_contents."]

    link_index = -1
    for annot_ref in annots:
        try:
            annot = pdf.get_object(annot_ref.objgen) if hasattr(annot_ref, 'objgen') else annot_ref
        except Exception:
            annot = annot_ref
        if not isinstance(annot, pikepdf.Dictionary):
            annot = annot_ref
        if not isinstance(annot, pikepdf.Dictionary):
            continue
        if str(annot.get("/Subtype") or "") != "/Link":
            continue
        link_index += 1
        if link_index != target_link_index:
            continue

        before = annot.get("/Contents")
        before_text = str(before).strip() if before is not None else None
        if before_text == contents:
            return False, [], [f"Link annotation {page_number}:{target_link_index} already has matching /Contents."]

        annot["/Contents"] = pikepdf.String(contents)
        return True, [{
            "ref": ref_string(annot),
            "before": before_text,
            "after": contents,
            "details": f'Set link annotation /Contents to "{contents}".',
        }], []

    return False, [], [f"Could not find link annotation {page_number}:{target_link_index} for set_link_annotation_contents."]


def mutate_normalize_nested_figure_containers(pdf, mutation):
    def count_descendant_figures(node):
        count = 0
        visited = set()

        def visit(value, is_root=False):
            nonlocal count
            if not isinstance(value, pikepdf.Dictionary):
                return
            node_ref = ref_string(value)
            if node_ref and node_ref in visited:
                return
            if node_ref:
                visited.add(node_ref)
            if not is_root and str(value.get("/S")) == "/Figure":
                count += 1
            kids = value.get("/K")
            if isinstance(kids, pikepdf.Array):
                for child in kids:
                    visit(child)
            elif isinstance(kids, pikepdf.Dictionary):
                visit(kids)

        visit(node, is_root=True)
        return count

    def descendant_leaf_figures_with_direct_content(node):
        figures = []
        visited = set()

        def visit(value, is_root=False):
            if not isinstance(value, pikepdf.Dictionary):
                return
            node_ref = ref_string(value)
            if node_ref and node_ref in visited:
                return
            if node_ref:
                visited.add(node_ref)
            if not is_root and str(value.get("/S")) == "/Figure" and direct_struct_elem_mcids(value):
                figures.append(value)
            kids = value.get("/K")
            if isinstance(kids, pikepdf.Array):
                for child in kids:
                    visit(child)
            elif isinstance(kids, pikepdf.Dictionary):
                visit(kids)

        visit(node, is_root=True)
        return figures

    applied = []
    for obj in iter_struct_elems(pdf):
        if str(obj.get("/S")) != "/Figure":
            continue

        kids = obj.get("/K")
        if isinstance(kids, pikepdf.Array):
            child_values = list(kids)
        elif kids is None:
            child_values = []
        else:
            child_values = [kids]

        child_figures = count_descendant_figures(obj)
        has_non_struct_kid = False
        for child in child_values:
            if not isinstance(child, pikepdf.Dictionary):
                has_non_struct_kid = True
                continue
            child_tag = str(child.get("/S"))
            if not child_tag:
                has_non_struct_kid = True

        mcids = normalized_struct_elem_mcids(obj)
        if child_figures <= 0 or has_non_struct_kid or mcids:
            continue

        before_alt = obj.get("/Alt")
        before_alt_text = str(before_alt).replace("u:", "").strip() if before_alt is not None else None
        if before_alt_text:
          leaf_figures = [
              figure for figure in descendant_leaf_figures_with_direct_content(obj)
              if not str(figure.get("/Alt") or "").replace("u:", "").strip()
          ]
          if len(leaf_figures) == 1:
              leaf = leaf_figures[0]
              leaf["/Alt"] = before_alt
              applied.append({
                  "ref": ref_string(leaf),
                  "before": None,
                  "after": before_alt_text,
                  "details": (
                      f"Moved wrapper alt text from {ref_string(obj)} onto descendant figure {ref_string(leaf)} "
                      "so the real marked-content figure carries the alternate description."
                  ),
              })
        if before_alt is not None:
            try:
                del obj["/Alt"]
            except Exception:
                pass
        obj["/S"] = pikepdf.Name("/Sect")
        applied.append({
            "ref": ref_string(obj),
            "before": before_alt_text or "/Figure",
            "after": "/Sect",
            "details": f"Retagged empty wrapper figure container {ref_string(obj)} as /Sect because it contains {child_figures} child /Figure element(s) and no direct marked content.",
        })

    if not applied:
        return False, [], ["No nested wrapper figure containers required normalization."]
    return True, applied, []


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
    selected = tables if not requested else [
        table for table in tables
        if (
            table["ref"] in requested
            or any(cell_ref in requested for cell_ref in table["firstRowCellRefs"])
            or any(cell_ref in requested for cell_ref in table["headerCellRefs"])
        )
    ]
    applied = []
    for table in selected:
        header_refs = []
        table_obj = resolve_obj(pdf, table["ref"])
        row_nodes = []
        if isinstance(table_obj, pikepdf.Dictionary):
            row_nodes = table_row_dicts(table_obj)
            if row_nodes:
                def cell_span(cell):
                    try:
                        attrs = cell.get("/A")
                        if isinstance(attrs, pikepdf.Dictionary):
                            return max(1, int(attrs.get("/ColSpan", cell.get("/ColSpan", 1)) or 1))
                        return max(1, int(cell.get("/ColSpan", 1) or 1))
                    except Exception:
                        return 1
                def ensure_attrs(cell):
                    attrs = cell.get("/A")
                    if isinstance(attrs, pikepdf.Dictionary):
                        return attrs
                    attrs = pikepdf.Dictionary()
                    cell["/A"] = attrs
                    return attrs
                row_column_counts = []
                row_cells = []
                for row in row_nodes:
                    cells = [cell for cell in get_child_dicts(row) if str(cell.get("/S")) in {"/TD", "/TH"}]
                    row_cells.append(cells)
                    row_column_counts.append(sum(cell_span(cell) for cell in cells))
                max_columns = max(row_column_counts) if row_column_counts else 0
                if max_columns > 1:
                    for row_index, cells in enumerate(row_cells):
                        current_width = row_column_counts[row_index] if row_index < len(row_column_counts) else 0
                        if (
                            current_width < max_columns
                            and len(cells) >= 2
                            and str(cells[0].get("/S")) == "/TH"
                            and all(str(cell.get("/S")) in {"/TH", "/TD"} for cell in cells[1:])
                            and all(cell_span(cell) == 1 for cell in cells)
                        ):
                            inferred_spans = None
                            inferred_row_spans = [1] * len(cells)
                            remaining_cells = len(cells) - 1
                            remaining_columns = max_columns - 1
                            next_width = row_column_counts[row_index + 1] if row_index + 1 < len(row_column_counts) else 0
                            next_cells = row_cells[row_index + 1] if row_index + 1 < len(row_cells) else []
                            next_is_data_only = bool(next_cells) and all(str(cell.get("/S")) == "/TD" for cell in next_cells)
                            if next_is_data_only and next_width == max_columns - 1 and len(cells) >= 2:
                                inferred_row_spans[0] = 2
                            if remaining_cells > 0 and remaining_columns > 0 and remaining_columns % remaining_cells == 0:
                                repeated_span = max(1, remaining_columns // remaining_cells)
                                if repeated_span > 1:
                                    inferred_spans = [1] + [repeated_span] * remaining_cells
                            elif len(cells) > 0 and max_columns % len(cells) == 0:
                                repeated_span = max(1, max_columns // len(cells))
                                if repeated_span > 1:
                                    inferred_spans = [repeated_span] * len(cells)
                            if inferred_spans:
                                for cell, inferred_span, inferred_row_span in zip(cells, inferred_spans, inferred_row_spans):
                                    current_span = cell_span(cell)
                                    if current_span == inferred_span:
                                        if inferred_row_span <= 1:
                                            continue
                                    attrs = ensure_attrs(cell)
                                    attrs["/ColSpan"] = pikepdf.Integer(inferred_span)
                                    if inferred_row_span > 1:
                                        attrs["/RowSpan"] = pikepdf.Integer(inferred_row_span)
                                    applied.append({
                                        "ref": ref_string(cell),
                                        "before": str(current_span),
                                        "after": (
                                            f"/ColSpan {inferred_span}, /RowSpan {inferred_row_span}"
                                            if inferred_row_span > 1
                                            else str(inferred_span)
                                        ),
                                        "details": (
                                            f"Inferred grouped-header span metadata for {ref_string(cell)} "
                                            f"so row {row_index + 1} aligns with the table's {max_columns}-column body."
                                        ),
                                    })
                                continue
                        if len(cells) != 1:
                            continue
                        title_cell = cells[0]
                        current_span = cell_span(title_cell)
                        if current_span == max_columns:
                            continue
                        ensure_attrs(title_cell)["/ColSpan"] = pikepdf.Integer(max_columns)
                        applied.append({
                            "ref": ref_string(title_cell),
                            "before": str(current_span),
                            "after": str(max_columns),
                            "details": (
                                f"Expanded single-cell row {row_index + 1} table title cell {ref_string(title_cell)} "
                                f"to /ColSpan {max_columns} so header/data rows align."
                            ),
                        })
        first_row_refs = list(table["firstRowCellRefs"])
        if not first_row_refs and row_nodes:
            for row in row_nodes:
                cells = [cell for cell in get_child_dicts(row) if str(cell.get("/S")) in {"/TD", "/TH"}]
                if len(cells) > 1:
                    first_row_refs = [ref_string(cell) for cell in cells if ref_string(cell)]
                    break
            if not first_row_refs:
                for row in row_nodes:
                    cells = [cell for cell in get_child_dicts(row) if str(cell.get("/S")) in {"/TD", "/TH"}]
                    if cells:
                        first_row_refs = [ref_string(cell) for cell in cells if ref_string(cell)]
                        break
        for cell_ref in first_row_refs:
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
        return False, [], [f"Target {target_ref} has tag {before_tag} and is not a /Figure element."]
    before_alt = obj.get("/Alt")
    before_alt_text = str(before_alt).replace("u:", "") if isinstance(before_alt, str) else None
    obj["/Alt"] = pikepdf.String(alt_text)
    applied = [{
        "ref": ref_string(obj),
        "before": before_alt_text or before_tag,
        "after": alt_text,
        "details": f"Set alternate text on {before_tag} element {ref_string(obj)} to \"{alt_text}\".",
    }]
    applied.extend(remove_alt_from_descendants(obj, skip_ref=ref_string(obj), preserve_leaf_figure_alt=True))
    applied.extend(mirror_alt_text_to_matching_struct_elems(pdf, obj, alt_text))
    return True, applied, []


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
    strong_figure_evidence = image_evidence in {"strong", "vector"}
    page_image_count = mutation.get("pageImageCount")
    try:
        page_image_count = int(page_image_count) if page_image_count is not None else 0
    except Exception:
        page_image_count = 0
    if text_density == "high" and before_tag != "/TextBox" and not strong_figure_evidence:
        return False, [], [f"text_heavy_candidate: Target {target_ref} appears text-heavy and is not safe to retag as /Figure."]
    if image_evidence and not strong_figure_evidence:
        return False, [], [f"no_figure_evidence: Target {target_ref} does not have strong enough figure evidence for automatic figure retagging."]
    if page_image_count <= 0 and not strong_figure_evidence:
        return False, [], [f"no_figure_evidence: Page context for {target_ref} does not indicate any renderable figure evidence."]
    if before_tag not in SAFE_FIGURE_RETAG_TAGS:
        if before_tag not in FIGURE_WRAP_TAGS:
            return False, [], [f"Target {target_ref} has tag {before_tag} and is not safe to retag as /Figure."]
        original_k = obj.get("/K")
        if original_k is None:
            return False, [], [f"Target {target_ref} has tag {before_tag} but does not expose content to wrap in a /Figure child."]
        if has_descendant_leaf_figure_with_alt(obj):
            return False, [], [f"Target {target_ref} already contains a descendant /Figure with alternate text."]
        figure = pdf.make_indirect(pikepdf.Dictionary({
            "/Type": pikepdf.Name("/StructElem"),
            "/S": pikepdf.Name("/Figure"),
            "/P": obj,
            "/K": original_k,
            "/Alt": pikepdf.String(alt_text),
        }))
        obj["/K"] = figure
        try:
            if obj.get("/Alt") is not None:
                del obj["/Alt"]
        except Exception:
            pass
        if isinstance(original_k, pikepdf.Dictionary):
            original_k["/P"] = figure
        elif isinstance(original_k, pikepdf.Array):
            for child in original_k:
                if isinstance(child, pikepdf.Dictionary):
                    child["/P"] = figure
        applied = [{
            "ref": ref_string(figure),
            "before": before_tag,
            "after": alt_text,
            "details": f"Wrapped content of {ref_string(obj)} in a child /Figure and set alt text to \"{alt_text}\".",
        }]
        applied.extend(remove_alt_from_descendants(figure, skip_ref=ref_string(figure), preserve_leaf_figure_alt=True))
        applied.extend(mirror_alt_text_to_matching_struct_elems(pdf, figure, alt_text))
        return True, applied, []
    if ancestry & UNSAFE_FIGURE_ANCESTRY:
        original_k = obj.get("/K")
        if original_k is None:
            return False, [], [f"unsafe_ancestry: Target {target_ref} is nested under {', '.join(sorted(ancestry & UNSAFE_FIGURE_ANCESTRY))} and does not expose content to wrap in a /Figure child."]
        if has_descendant_leaf_figure_with_alt(obj):
            return False, [], [f"Target {target_ref} already contains a descendant /Figure with alternate text."]
        figure = pdf.make_indirect(pikepdf.Dictionary({
            "/Type": pikepdf.Name("/StructElem"),
            "/S": pikepdf.Name("/Figure"),
            "/P": obj,
            "/K": original_k,
            "/Alt": pikepdf.String(alt_text),
        }))
        obj["/K"] = figure
        try:
            if obj.get("/Alt") is not None:
                del obj["/Alt"]
        except Exception:
            pass
        if isinstance(original_k, pikepdf.Dictionary):
            original_k["/P"] = figure
        elif isinstance(original_k, pikepdf.Array):
            for child in original_k:
                if isinstance(child, pikepdf.Dictionary):
                    child["/P"] = figure
        applied = [{
            "ref": ref_string(figure),
            "before": before_tag,
            "after": alt_text,
            "details": f"Wrapped content under {ref_string(obj)} in a child /Figure despite unsafe ancestry and set alt text to \"{alt_text}\".",
        }]
        applied.extend(remove_alt_from_descendants(figure, skip_ref=ref_string(figure), preserve_leaf_figure_alt=True))
        applied.extend(mirror_alt_text_to_matching_struct_elems(pdf, figure, alt_text))
        return True, applied, []
    obj["/S"] = pikepdf.Name("/Figure")
    obj["/Alt"] = pikepdf.String(alt_text)
    applied = [{
        "ref": ref_string(obj),
        "before": before_tag,
        "after": alt_text,
        "details": f"Retagged {ref_string(obj)} as /Figure and set alt text to \"{alt_text}\".",
    }]
    applied.extend(remove_alt_from_descendants(obj, skip_ref=ref_string(obj), preserve_leaf_figure_alt=True))
    applied.extend(mirror_alt_text_to_matching_struct_elems(pdf, obj, alt_text))
    return True, applied, []


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
        "acrobatAltRiskNodes": acrobat_alt_risk_nodes(pdf) if include_image_struct_nodes else [],
        "untaggedTopLevelContentGroups": untagged_top_level_content_groups(pdf, include_text_groups=True),
        "readingOrderNodes": reading_order_nodes(pdf),
        "readingOrderParents": reading_order_parents(pdf),
    }


def empty_snapshot():
    return {
        "headings": [],
        "structuralNodes": [],
        "tables": [],
        "figures": [],
        "imageStructNodes": [],
        "acrobatAltRiskNodes": [],
        "untaggedTopLevelContentGroups": [],
        "readingOrderNodes": [],
        "readingOrderParents": [],
    }


def analyze_reading_order_pdfminer(pdf_path, request):
    try:
        from pdfminer.high_level import extract_pages
        from pdfminer.layout import LTTextBox, LTTextLine, LAParams
    except ImportError:
        return {"status": "unavailable", "disorder_ratio": None, "pages_analyzed": 0,
                "total_blocks": 0, "disordered_block_count": 0, "disordered_blocks": [], "warnings": []}

    max_pages = request.get("maxPages", 20)

    try:
        laparams = LAParams(all_texts=True)
        stream_blocks = []  # (stream_order_index, page_num, x0, y0, x1, y1, text_preview)

        for page_num, page_layout in enumerate(extract_pages(pdf_path, laparams=laparams), start=1):
            if page_num > max_pages:
                break
            for element in page_layout:
                if isinstance(element, LTTextBox):
                    text = element.get_text().strip()[:60]
                    stream_blocks.append({
                        "page": page_num,
                        "stream_idx": len(stream_blocks),
                        "x0": element.x0,
                        "y0": element.y0,
                        "x1": element.x1,
                        "y1": element.y1,
                        "text": text,
                    })

        if len(stream_blocks) < 2:
            return {"status": "ok", "disorder_ratio": 0.0, "pages_analyzed": page_num if stream_blocks else 0,
                    "total_blocks": len(stream_blocks), "disordered_block_count": 0, "disordered_blocks": [], "warnings": []}

        # Compute visual order per page (top-to-bottom, left-to-right = sort by -y1 then x0)
        # Assign visual rank across all blocks (per-page then concatenate)
        pages_seen = sorted(set(b["page"] for b in stream_blocks))
        visual_rank = {}  # stream_idx -> visual rank
        rank = 0
        for pn in pages_seen:
            page_blocks = [b for b in stream_blocks if b["page"] == pn]
            page_blocks_sorted = sorted(page_blocks, key=lambda b: (-b["y1"], b["x0"]))
            for b in page_blocks_sorted:
                visual_rank[b["stream_idx"]] = rank
                rank += 1

        # Count inversions: pairs (i,j) where stream order i<j but visual_rank[i] > visual_rank[j]
        n = len(stream_blocks)
        inversions = 0
        disordered = []
        for i in range(n):
            for j in range(i + 1, n):
                bi = stream_blocks[i]
                bj = stream_blocks[j]
                if bi["page"] != bj["page"]:
                    continue  # only check within same page
                if visual_rank[bi["stream_idx"]] > visual_rank[bj["stream_idx"]]:
                    inversions += 1
                    if len(disordered) < 10:
                        disordered.append({
                            "page": bi["page"],
                            "stream_rank": bi["stream_idx"],
                            "visual_rank": visual_rank[bi["stream_idx"]],
                            "text_preview": bi["text"][:40],
                        })

        # Total pairs within same page
        total_pairs = sum(
            len(page_blocks) * (len(page_blocks) - 1) // 2
            for page in pages_seen
            for page_blocks in [[b for b in stream_blocks if b["page"] == page]]
        )

        disorder_ratio = inversions / total_pairs if total_pairs > 0 else 0.0

        return {
            "status": "ok",
            "disorder_ratio": round(disorder_ratio, 4),
            "pages_analyzed": len(pages_seen),
            "total_blocks": len(stream_blocks),
            "disordered_block_count": len(disordered),
            "disordered_blocks": disordered,
            "warnings": [],
        }
    except Exception as exc:
        return {"status": "error", "disorder_ratio": None, "pages_analyzed": 0,
                "total_blocks": 0, "disordered_block_count": 0, "disordered_blocks": [],
                "warnings": [str(exc)]}


def dispatch_single_operation(pdf, operation, request):
    """Route a single operation name to its mutate_* function.

    Returns (changed: bool, applied: list, warnings: list).
    Returns (False, [], ["unsupported: <op>"]) for unknown operations.
    Not intended for 'inspect', 'batch_mutate', or 'analyze_reading_order_pdfminer'.
    """
    if operation == "bootstrap_struct_tree":
        return mutate_bootstrap_struct_tree(pdf, request)
    elif operation == "set_pdfua_identification":
        return mutate_set_pdfua_identification(pdf, request)
    elif operation == "normalize_annotation_tab_order":
        return mutate_normalize_annotation_tab_order(pdf, request)
    elif operation == "set_tabs_all_annotated_pages":
        return mutate_set_tabs_all_annotated_pages(pdf, request)
    elif operation == "repair_cid_symbol_font_maps":
        return mutate_repair_cid_symbol_font_maps(pdf, request)
    elif operation == "repair_cidset_consistency":
        return mutate_repair_cidset_consistency(pdf, request)
    elif operation == "repair_structure_conformance":
        return mutate_repair_structure_conformance(pdf, request)
    elif operation == "repair_type1_font_unicode_maps":
        return mutate_repair_type1_font_unicode_maps(pdf, request)
    elif operation == "repair_reported_font_widths":
        return mutate_repair_reported_font_widths(pdf, request)
    elif operation == "substitute_legacy_fonts_in_place":
        return mutate_substitute_legacy_fonts_in_place(pdf, request)
    elif operation == "finalize_substituted_font_conformance":
        return mutate_finalize_substituted_font_conformance(pdf, request)
    elif operation == "repair_note_tag_ids":
        return mutate_repair_note_tag_ids(pdf, request)
    elif operation == "repair_native_marked_content_refs":
        return mutate_repair_native_marked_content_refs(pdf, request)
    elif operation == "repair_native_link_structure":
        return mutate_repair_native_link_structure(pdf, request)
    elif operation == "repair_bootstrapped_chart_content_refs":
        return mutate_repair_bootstrapped_chart_content_refs(pdf, request)
    elif operation == "repair_native_figure_semantics":
        return mutate_repair_native_figure_semantics(pdf, request)
    elif operation == "repair_other_elements_alt_text":
        return mutate_repair_other_elements_alt_text(pdf, request)
    elif operation == "repair_native_table_headers":
        return mutate_repair_native_table_headers(pdf, request)
    elif operation == "repair_native_reading_order":
        return mutate_repair_native_reading_order(pdf, request)
    elif operation == "repair_font_unicode_maps":
        return mutate_repair_font_unicode_maps(pdf, request)
    elif operation == "repair_annotation_alt_text":
        return mutate_repair_annotation_alt_text(pdf, request)
    elif operation == "repair_truetype_encoding_differences":
        return mutate_repair_truetype_encoding_differences(pdf, request)
    elif operation == "embed_missing_fonts_in_place":
        return mutate_embed_missing_fonts_in_place(pdf, request)
    elif operation == "repair_malformed_bdc_operators":
        return mutate_repair_malformed_bdc_operators(pdf, request)
    elif operation == "artifact_nonsemantic_page_elements":
        return mutate_artifact_nonsemantic_page_elements(pdf, request)
    elif operation == "replace_bookmarks_from_headings":
        return mutate_replace_bookmarks_from_headings(pdf, request)
    elif operation == "create_heading_tag":
        return mutate_create_heading_tag(pdf, request)
    elif operation == "create_heading_from_candidate":
        return mutate_create_heading_from_candidate(pdf, request)
    elif operation == "normalize_heading_hierarchy":
        return mutate_normalize_heading_hierarchy(pdf, request)
    elif operation == "set_link_annotation_contents":
        return mutate_set_link_annotation_contents(pdf, request)
    elif operation == "normalize_nested_figure_containers":
        return mutate_normalize_nested_figure_containers(pdf, request)
    elif operation == "retag_node":
        return mutate_retag_node(pdf, request)
    elif operation == "set_table_header_cells":
        return mutate_set_table_header_cells(pdf, request)
    elif operation == "set_figure_alt_text":
        return mutate_set_figure_alt_text(pdf, request)
    elif operation == "retag_as_figure_and_set_alt":
        return mutate_retag_as_figure_and_set_alt(pdf, request)
    elif operation == "mark_figure_decorative":
        return mutate_mark_figure_decorative(pdf, request)
    elif operation == "reorder_structure_children":
        return mutate_reorder_structure_children(pdf, request)
    else:
        return False, [], [f"unsupported: {operation}"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--request", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    request = json.loads(Path(args.request).read_text(encoding="utf-8"))

    operation = request.get("operation")

    # Read-only analysis operations — handle before opening with pikepdf
    if operation == "analyze_reading_order_pdfminer":
        result = analyze_reading_order_pdfminer(args.input, request)
        print(json.dumps(result))
        return

    pdf = pikepdf.Pdf.open(args.input)

    include_snapshot = request.get("includeSnapshot")
    if include_snapshot is None:
        include_snapshot = operation == "inspect"
    include_snapshot = bool(include_snapshot)
    warnings = []
    changed = False
    applied = []

    inspect_mode = str(request.get("inspectMode") or "light")

    if operation == "inspect":
        pass
    elif operation == "batch_mutate":
        # Run a list of operations sequentially on the same PDF object — one spawn, one save, one snapshot.
        # Each sub-operation result is recorded individually so the TS side can map back to per-tool outcomes.
        sub_ops = request.get("operations", [])
        per_op_results = []
        for sub_req in sub_ops:
            sub_op = sub_req.get("operation", "")
            try:
                op_changed, op_applied, op_warnings = dispatch_single_operation(pdf, sub_op, sub_req)
            except Exception as exc:
                op_changed, op_applied, op_warnings = False, [], [f"error in {sub_op}: {exc}"]
            if op_changed:
                changed = True
            applied.extend(op_applied)
            warnings.extend(op_warnings)
            per_op_results.append({
                "operation": sub_op,
                "status": "applied" if op_changed else ("unsupported" if op_warnings and op_warnings[0].startswith("unsupported:") else "no_effect"),
                "changedDocumentBytes": op_changed,
                "appliedMutations": op_applied,
                "warnings": op_warnings,
            })
        snap = snapshot(pdf, inspect_mode) if include_snapshot else empty_snapshot()
        print(json.dumps({
            "status": "applied" if changed else "no_effect",
            "changedDocumentBytes": changed,
            "appliedMutations": applied,
            "warnings": warnings,
            "operationResults": per_op_results,
            **snap,
        }))
        if changed:
            pdf.save(args.output)
        return
    else:
        changed, applied, warnings = dispatch_single_operation(pdf, operation, request)
        if not changed and not applied and warnings and warnings[0].startswith("unsupported:"):
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

    snap = snapshot(pdf, inspect_mode) if include_snapshot else empty_snapshot()
    print(json.dumps({
        "status": "applied" if changed else "no_effect",
        "changedDocumentBytes": changed,
        "appliedMutations": applied,
        "warnings": warnings,
        **snap,
    }))


if __name__ == "__main__":
    main()
