#!/usr/bin/env python3
"""PDF accessibility extras: color contrast and table structure detection."""
import argparse
import json
import os
import subprocess
import shutil
import sys
import tempfile

def analyze_color_contrast(pdf_path, request):
    """Analyze color contrast of text against background in rendered PDF pages."""
    if not shutil.which('pdftoppm'):
        return {
            "status": "unavailable",
            "reason": "pdftoppm not found. Install poppler-utils: sudo apt install poppler-utils",
            "pages_analyzed": 0, "total_samples": 0,
            "failing_contrast_count": 0, "fail_ratio": None, "failures": [], "warnings": []
        }

    try:
        from PIL import Image
    except ImportError:
        return {
            "status": "unavailable",
            "reason": "Pillow not installed.",
            "pages_analyzed": 0, "total_samples": 0,
            "failing_contrast_count": 0, "fail_ratio": None, "failures": [], "warnings": []
        }

    try:
        from pdfminer.high_level import extract_pages
        from pdfminer.layout import LTTextBox, LTTextLine, LTChar, LAParams
        has_pdfminer = True
    except ImportError:
        has_pdfminer = False

    max_pages = request.get("maxPages", 10)
    dpi = 150

    try:
        # Get page count via pikepdf (already available)
        try:
            import pikepdf
            with pikepdf.open(pdf_path) as pdf:
                page_count = len(pdf.pages)
        except Exception:
            page_count = max_pages

        pages_to_analyze = min(page_count, max_pages)
        failures = []
        total_samples = 0
        tmpdir = tempfile.mkdtemp(prefix='pdf-contrast-')

        try:
            for page_num in range(1, pages_to_analyze + 1):
                # Render page to PNG
                prefix = os.path.join(tmpdir, f'page-{page_num}')
                result = subprocess.run(
                    ['pdftoppm', '-r', str(dpi), '-png', '-f', str(page_num), '-l', str(page_num), pdf_path, prefix],
                    capture_output=True, timeout=30
                )
                if result.returncode != 0:
                    continue

                # Find the rendered PNG file
                png_files = [f for f in os.listdir(tmpdir) if f.startswith(f'page-{page_num}') and f.endswith('.png')]
                if not png_files:
                    continue

                img_path = os.path.join(tmpdir, png_files[0])
                img = Image.open(img_path).convert('RGB')
                img_width, img_height = img.size
                pixels = img.load()

                if has_pdfminer:
                    # Use pdfminer to get text character positions
                    laparams = LAParams()
                    page_width = None
                    page_height = None

                    for pn, page_layout in enumerate(extract_pages(pdf_path, laparams=laparams), start=1):
                        if pn == page_num:
                            page_width = page_layout.width
                            page_height = page_layout.height

                            for element in page_layout:
                                if not isinstance(element, LTTextBox):
                                    continue
                                for line in element:
                                    if not isinstance(line, LTTextLine):
                                        continue
                                    # Collect characters in this line
                                    chars = [c for c in line if isinstance(c, LTChar) and c.get_text().strip()]
                                    if not chars:
                                        continue

                                    # Get line bbox
                                    lx0 = min(c.x0 for c in chars)
                                    ly0 = min(c.y0 for c in chars)
                                    lx1 = max(c.x1 for c in chars)
                                    ly1 = max(c.y1 for c in chars)
                                    font_size = chars[0].size if chars else 0

                                    # Map PDF coords to image pixels (PDF origin is bottom-left, image is top-left)
                                    scale_x = img_width / page_width
                                    scale_y = img_height / page_height

                                    px0 = int(lx0 * scale_x)
                                    py0 = int((page_height - ly1) * scale_y)
                                    px1 = int(lx1 * scale_x)
                                    py1 = int((page_height - ly0) * scale_y)

                                    # Clamp to image bounds
                                    px0 = max(0, min(px0, img_width - 1))
                                    px1 = max(0, min(px1, img_width - 1))
                                    py0 = max(0, min(py0, img_height - 1))
                                    py1 = max(0, min(py1, img_height - 1))

                                    if px1 <= px0 or py1 <= py0:
                                        continue

                                    # Sample foreground (darkest pixel in text region) and background (lightest)
                                    fg_r, fg_g, fg_b = 255, 255, 255
                                    bg_r, bg_g, bg_b = 0, 0, 0

                                    sample_step = max(1, (px1 - px0) // 8)
                                    for sx in range(px0, px1, sample_step):
                                        for sy in range(py0, py1, max(1, (py1 - py0) // 6)):
                                            r, g, b = pixels[sx, sy]
                                            lum = 0.299 * r + 0.587 * g + 0.114 * b
                                            fg_lum = 0.299 * fg_r + 0.587 * fg_g + 0.114 * fg_b
                                            bg_lum = 0.299 * bg_r + 0.587 * bg_g + 0.114 * bg_b
                                            if lum < fg_lum:
                                                fg_r, fg_g, fg_b = r, g, b
                                            if lum > bg_lum:
                                                bg_r, bg_g, bg_b = r, g, b

                                    # Compute WCAG relative luminance and contrast ratio
                                    def relative_luminance(r, g, b):
                                        def linearize(c):
                                            s = c / 255.0
                                            return s / 12.92 if s <= 0.04045 else ((s + 0.055) / 1.055) ** 2.4
                                        return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b)

                                    L1 = relative_luminance(fg_r, fg_g, fg_b)
                                    L2 = relative_luminance(bg_r, bg_g, bg_b)
                                    lighter = max(L1, L2)
                                    darker = min(L1, L2)
                                    contrast = (lighter + 0.05) / (darker + 0.05)

                                    total_samples += 1

                                    # Determine threshold based on font size
                                    is_large = font_size >= 18  # TODO: check bold for 14pt threshold
                                    threshold = 3.0 if is_large else 4.5

                                    if contrast < threshold and len(failures) < 50:
                                        text_preview = line.get_text().strip()[:40]
                                        failures.append({
                                            "page": page_num,
                                            "text_preview": text_preview,
                                            "contrast_ratio": round(contrast, 2),
                                            "threshold": threshold,
                                            "fg_color": f'#{fg_r:02x}{fg_g:02x}{fg_b:02x}',
                                            "bg_color": f'#{bg_r:02x}{bg_g:02x}{bg_b:02x}',
                                            "font_size_pt": round(font_size, 1),
                                        })
                            break  # found the right page, stop iterating
                else:
                    # Fallback: sample random pixel pairs without text position knowledge
                    # This is a coarse heuristic — just report unavailable if pdfminer is missing
                    pass
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

        fail_ratio = len(failures) / total_samples if total_samples > 0 else 0.0

        return {
            "status": "ok",
            "pages_analyzed": pages_to_analyze,
            "total_samples": total_samples,
            "failing_contrast_count": len(failures),
            "fail_ratio": round(fail_ratio, 4),
            "failures": failures[:20],  # cap at 20 for response size
            "warnings": [] if has_pdfminer else ["pdfminer not installed; text position data unavailable — contrast analysis skipped"],
        }

    except subprocess.TimeoutExpired:
        return {"status": "timeout", "pages_analyzed": 0, "total_samples": 0,
                "failing_contrast_count": 0, "fail_ratio": None, "failures": [], "warnings": []}
    except Exception as exc:
        return {"status": "error", "pages_analyzed": 0, "total_samples": 0,
                "failing_contrast_count": 0, "fail_ratio": None, "failures": [],
                "warnings": [str(exc)]}


def analyze_table_structure(pdf_path, request):
    """Detect tables visually using tabula-py and compare against tagged table count."""
    tagged_table_count = request.get("taggedTableCount", 0)

    try:
        import tabula
    except ImportError:
        try:
            import camelot
        except ImportError:
            return {
                "status": "unavailable",
                "reason": "Neither tabula-py nor camelot-py installed. Install with: pip install tabula-py",
                "detected_tables": None, "tagged_tables": tagged_table_count,
                "untagged_tables": None, "table_details": [], "warnings": []
            }

    try:
        # Try tabula first (lattice mode = tables with visible borders)
        tables = []
        try:
            import tabula as tb
            dfs = tb.read_pdf(pdf_path, pages='all', lattice=True, silent=True,
                              pandas_options={'header': None})
            tables = [df for df in dfs if df is not None and not df.empty and df.shape[0] > 1]
            if not tables:
                # Fallback to stream mode
                dfs = tb.read_pdf(pdf_path, pages='all', stream=True, silent=True,
                                  pandas_options={'header': None})
                tables = [df for df in dfs if df is not None and not df.empty and df.shape[0] > 1]
        except Exception:
            # Try camelot as fallback
            try:
                import camelot as cm
                camelot_tables = cm.read_pdf(pdf_path, pages='all', flavor='lattice')
                tables = [t for t in camelot_tables if t.shape[0] > 1]
            except Exception:
                pass

        detected_count = len(tables)
        untagged = max(0, detected_count - tagged_table_count)

        table_details = []
        for i, t in enumerate(tables[:20]):
            try:
                rows = t.shape[0] if hasattr(t, 'shape') else 0
                cols = t.shape[1] if hasattr(t, 'shape') else 0
                table_details.append({"table_index": i, "rows": rows, "cols": cols})
            except Exception:
                pass

        return {
            "status": "ok",
            "detected_tables": detected_count,
            "tagged_tables": tagged_table_count,
            "untagged_tables": untagged,
            "table_details": table_details,
            "warnings": [],
        }

    except Exception as exc:
        return {
            "status": "error",
            "detected_tables": None, "tagged_tables": tagged_table_count,
            "untagged_tables": None, "table_details": [],
            "warnings": [str(exc)]
        }


def main():
    parser = argparse.ArgumentParser(description='PDF Accessibility Extras')
    parser.add_argument('--input', required=True, help='Path to input PDF')
    parser.add_argument('--request', required=True, help='Path to JSON request file')
    args = parser.parse_args()

    with open(args.request, 'r') as f:
        request = json.load(f)

    operation = request.get('operation', '')

    if operation == 'analyze_color_contrast':
        result = analyze_color_contrast(args.input, request)
    elif operation == 'analyze_table_structure':
        result = analyze_table_structure(args.input, request)
    else:
        result = {"status": "error", "warnings": [f"Unknown operation: {operation}"]}

    print(json.dumps(result))


if __name__ == '__main__':
    main()
