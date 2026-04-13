#!/usr/bin/env python3
import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageDraw

REPO_ROOT = Path("/home/hendo420/pdfaf")
DETAIL_PATH = REPO_ROOT / "ICJIA-PDFs/reports/visual-parity/remediated-80-plus-visual-parity.json"
OUTPUT_ROOT = REPO_ROOT / "ICJIA-PDFs/reports/visual-parity/flagged-material-review"
RENDER_DPI = 144
TOP_PAGES_PER_FILE = 3
PANEL_GAP = 24
LABEL_HEIGHT = 48
MARGIN = 24
BG = (248, 246, 240)
TEXT = (32, 32, 32)


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2)
        handle.write("\n")


def render_page(pdf_path: str, page_number: int, output_stem: Path) -> Path:
    output_stem.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "pdftoppm",
            "-f",
            str(page_number),
            "-singlefile",
            "-r",
            str(RENDER_DPI),
            "-png",
            pdf_path,
            str(output_stem),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return output_stem.with_suffix(".png")


def make_diff_image(left: Image.Image, right: Image.Image) -> Image.Image:
    diff = ImageChops.difference(left, right)
    if diff.getbbox() is None:
        return diff
    return diff.point(lambda value: min(255, value * 4))


def add_panel_label(canvas: Image.Image, x: int, y: int, width: int, text: str) -> None:
    draw = ImageDraw.Draw(canvas)
    draw.text((x, y), text, fill=TEXT)
    draw.line((x, y + LABEL_HEIGHT - 8, x + width, y + LABEL_HEIGHT - 8), fill=(190, 186, 176), width=1)


def build_board(original_path: Path, remediated_path: Path, output_path: Path, title: str) -> dict[str, Any]:
    original = Image.open(original_path).convert("RGB")
    remediated = Image.open(remediated_path).convert("RGB")
    if remediated.size != original.size:
        remediated = remediated.resize(original.size)
    diff = make_diff_image(original, remediated)

    panel_width = original.width
    panel_height = original.height
    canvas_width = (panel_width * 3) + (PANEL_GAP * 2) + (MARGIN * 2)
    canvas_height = panel_height + LABEL_HEIGHT + (MARGIN * 2)
    canvas = Image.new("RGB", (canvas_width, canvas_height), BG)

    top_y = MARGIN + LABEL_HEIGHT
    columns = [
        ("Original", original),
        ("Remediated", remediated),
        ("Diff x4", diff),
    ]
    x = MARGIN
    for label, image in columns:
        add_panel_label(canvas, x, MARGIN, panel_width, label)
        canvas.paste(image, (x, top_y))
        x += panel_width + PANEL_GAP

    draw = ImageDraw.Draw(canvas)
    draw.text((MARGIN, 6), title, fill=TEXT)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output_path)
    return {"outputPath": str(output_path), "size": list(canvas.size)}


def build_html(review_rows: list[dict[str, Any]], output_path: Path) -> None:
    lines = [
        "<!doctype html>",
        "<html lang='en'>",
        "<head>",
        "<meta charset='utf-8' />",
        "<title>Material Visual Review</title>",
        "<style>",
        "body{font-family:Arial,sans-serif;background:#f8f6f0;color:#202020;margin:24px;}",
        "h1,h2{margin:0 0 12px 0;}",
        ".file{margin:0 0 36px 0;padding:20px;background:#fff;border:1px solid #ddd;}",
        ".meta{margin:0 0 12px 0;color:#444;}",
        ".grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:16px;}",
        ".card img{max-width:100%;height:auto;border:1px solid #ccc;background:#fff;}",
        ".card{background:#fafafa;padding:12px;border:1px solid #e3e3e3;}",
        "code{background:#eee;padding:2px 4px;}",
        "</style>",
        "</head>",
        "<body>",
        "<h1>Material Visual Review</h1>",
        f"<p>Generated from <code>{DETAIL_PATH}</code>. Each board shows original, remediated, and amplified diff for the highest-difference pages.</p>",
    ]
    for row in review_rows:
        lines.extend(
            [
                "<section class='file'>",
                f"<h2>{row['publicationId']} - {row['publicationTitle']}</h2>",
                (
                    f"<p class='meta'>Score: {row['finalScore']} | Max RMS diff: {row['maxRmsDiffPct']} | "
                    f"Changed pages: {', '.join(str(page) for page in row['nonZeroDiffPages'])}</p>"
                ),
                f"<p class='meta'>Original: <code>{row['originalPdfPath']}</code></p>",
                f"<p class='meta'>Remediated: <code>{row['remediatedPdfPath']}</code></p>",
                "<div class='grid'>",
            ]
        )
        for board in row["boards"]:
            rel = Path(board["outputPath"]).relative_to(output_path.parent)
            lines.extend(
                [
                    "<div class='card'>",
                    f"<div>Page {board['page']} | RMS {board['rmsDiffPct']} | Mean {board['meanAbsDiffPct']}</div>",
                    f"<img src='{rel.as_posix()}' alt='Review board for page {board['page']}' />",
                    "</div>",
                ]
            )
        lines.extend(["</div>", "</section>"])
    lines.extend(["</body>", "</html>"])
    output_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    detail_doc = read_json(DETAIL_PATH)
    rows = [row for row in detail_doc["pairs"] if row["classification"] == "material_change_check_manually"]
    if OUTPUT_ROOT.exists():
        shutil.rmtree(OUTPUT_ROOT)
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)

    workspace = Path(tempfile.mkdtemp(prefix="visual-review-boards-"))
    review_rows: list[dict[str, Any]] = []
    try:
        for row in rows:
            top_pages = sorted(row["pageMetrics"], key=lambda metric: metric["rmsDiffPct"], reverse=True)[:TOP_PAGES_PER_FILE]
            boards = []
            publication_dir = OUTPUT_ROOT / str(row["publicationId"])
            for metric in top_pages:
                page = int(metric["page"])
                original_png = render_page(row["originalPdfPath"], page, workspace / f"orig-{row['publicationId']}-{page}")
                remediated_png = render_page(row["remediatedPdfPath"], page, workspace / f"rem-{row['publicationId']}-{page}")
                board_path = publication_dir / f"page-{page}.png"
                board = build_board(
                    original_png,
                    remediated_png,
                    board_path,
                    f"{row['publicationId']} page {page}",
                )
                boards.append(
                    {
                        "page": page,
                        "rmsDiffPct": metric["rmsDiffPct"],
                        "meanAbsDiffPct": metric["meanAbsDiffPct"],
                        **board,
                    }
                )
            review_rows.append(
                {
                    "publicationId": row["publicationId"],
                    "publicationTitle": row["publicationTitle"],
                    "finalScore": row["finalScore"],
                    "maxRmsDiffPct": row["maxRmsDiffPct"],
                    "nonZeroDiffPages": row["nonZeroDiffPages"],
                    "originalPdfPath": row["originalPdfPath"],
                    "remediatedPdfPath": row["remediatedPdfPath"],
                    "boards": boards,
                }
            )
    finally:
        shutil.rmtree(workspace, ignore_errors=True)

    summary = {
        "generatedFrom": str(DETAIL_PATH),
        "outputRoot": str(OUTPUT_ROOT),
        "filesReviewed": len(review_rows),
        "pagesRendered": sum(len(row["boards"]) for row in review_rows),
    }
    write_json(OUTPUT_ROOT / "review-summary.json", summary)
    write_json(OUTPUT_ROOT / "review-boards.json", {"files": review_rows})
    build_html(review_rows, OUTPUT_ROOT / "index.html")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
