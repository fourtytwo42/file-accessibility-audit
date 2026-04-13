#!/usr/bin/env python3
import glob
import json
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageStat

REPO_ROOT = Path('/home/hendo420/pdfaf')
MANIFEST_PATH = REPO_ROOT / 'ICJIA-PDFs/manifests/all-remaining-79-down-rerun.outcomes.json'
REPORT_ROOT = REPO_ROOT / 'ICJIA-PDFs/reports/visual-parity'
DETAIL_PATH = REPORT_ROOT / 'all-remaining-79-down-rerun-80-plus-visual-parity.json'
SUMMARY_PATH = REPORT_ROOT / 'all-remaining-79-down-rerun-80-plus-visual-parity.summary.json'
RENDER_DPI = 96


@dataclass
class Pair:
    source_manifest: str
    publication_id: str | None
    publication_title: str | None
    processed_at: str | None
    final_score: float
    page_count: int
    original_pdf_path: str
    remediated_pdf_path: str


def read_json(path: Path) -> Any:
    with path.open('r', encoding='utf-8') as handle:
        return json.load(handle)


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', encoding='utf-8') as handle:
        json.dump(value, handle, indent=2)
        handle.write('\n')


def load_pairs() -> list[Pair]:
    pairs: list[Pair] = []
    if not MANIFEST_PATH.exists():
        return pairs
    doc = read_json(MANIFEST_PATH)
    for outcome in doc.get('outcomes', []):
        final = outcome.get('final') or {}
        original = outcome.get('original') or {}
        artifacts = outcome.get('artifacts') or {}
        score = final.get('overallScore')
        original_pdf_path = outcome.get('localCachePath')
        remediated_pdf_path = artifacts.get('remediatedPdfPath')
        if not isinstance(score, (int, float)) or score < 80:
            continue
        if not original_pdf_path or not remediated_pdf_path:
            continue
        if not os.path.exists(original_pdf_path) or not os.path.exists(remediated_pdf_path):
            continue
        page_count = final.get('pageCount') or original.get('pageCount') or 0
        pairs.append(
            Pair(
                source_manifest=str(MANIFEST_PATH),
                publication_id=None if outcome.get('publicationId') is None else str(outcome.get('publicationId')),
                publication_title=None if outcome.get('publicationTitle') is None else str(outcome.get('publicationTitle')),
                processed_at=None if outcome.get('processedAt') is None else str(outcome.get('processedAt')),
                final_score=float(score),
                page_count=int(page_count) if page_count else 0,
                original_pdf_path=str(original_pdf_path),
                remediated_pdf_path=str(remediated_pdf_path),
            )
        )
    pairs.sort(key=lambda pair: (-pair.final_score, pair.processed_at or '', pair.publication_id or ''))
    return pairs


def render_pdf_all_pages(pdf_path: str, output_dir: Path, prefix: str) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ['pdftoppm', '-r', str(RENDER_DPI), '-png', pdf_path, str(output_dir / prefix)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return sorted(Path(p) for p in glob.glob(str(output_dir / f'{prefix}-*.png')))


def compare_images(left_path: Path, right_path: Path) -> dict[str, Any]:
    left = Image.open(left_path).convert('RGB')
    right = Image.open(right_path).convert('RGB')
    original_right_size = right.size
    same_size = left.size == right.size
    if not same_size:
        right = right.resize(left.size)
    diff = ImageChops.difference(left, right)
    stat = ImageStat.Stat(diff)
    mean_abs = sum(stat.mean) / (len(stat.mean) * 255.0)
    rms = sum(stat.rms) / (len(stat.rms) * 255.0)
    return {
        'sameSize': same_size,
        'leftSize': list(left.size),
        'rightSize': list(original_right_size),
        'meanAbsDiffPct': round(mean_abs * 100, 6),
        'rmsDiffPct': round(rms * 100, 6),
        'changedPixelsPresent': diff.getbbox() is not None,
    }


def classify_pair(avg_mean_abs_diff_pct: float, max_rms_diff_pct: float) -> str:
    if max_rms_diff_pct == 0 and avg_mean_abs_diff_pct == 0:
        return 'exact_visual_match'
    if max_rms_diff_pct > 8 or avg_mean_abs_diff_pct > 3:
        return 'material_change_check_manually'
    if max_rms_diff_pct > 3 or avg_mean_abs_diff_pct > 1:
        return 'minor_visible_change'
    return 'non_zero_but_visually_close'


def audit_pair(pair: Pair, workspace: Path) -> dict[str, Any]:
    pair_slug = pair.publication_id or Path(pair.remediated_pdf_path).stem
    pair_root = workspace / pair_slug
    original_renders = render_pdf_all_pages(pair.original_pdf_path, pair_root / 'original', 'page')
    remediated_renders = render_pdf_all_pages(pair.remediated_pdf_path, pair_root / 'remediated', 'page')

    if len(original_renders) != len(remediated_renders):
        return {
            'sourceManifest': pair.source_manifest,
            'publicationId': pair.publication_id,
            'publicationTitle': pair.publication_title,
            'processedAt': pair.processed_at,
            'finalScore': pair.final_score,
            'originalPdfPath': pair.original_pdf_path,
            'remediatedPdfPath': pair.remediated_pdf_path,
            'pageCountExpected': pair.page_count,
            'pageCountOriginalRendered': len(original_renders),
            'pageCountRemediatedRendered': len(remediated_renders),
            'classification': 'page_count_mismatch_check_manually',
            'avgMeanAbsDiffPct': None,
            'avgRmsDiffPct': None,
            'maxRmsDiffPct': None,
            'nonZeroDiffPages': None,
            'pageMetrics': [],
        }

    page_metrics: list[dict[str, Any]] = []
    for index, (left_page, right_page) in enumerate(zip(original_renders, remediated_renders), start=1):
        metrics = compare_images(left_page, right_page)
        metrics['page'] = index
        page_metrics.append(metrics)

    avg_mean = sum(m['meanAbsDiffPct'] for m in page_metrics) / len(page_metrics)
    avg_rms = sum(m['rmsDiffPct'] for m in page_metrics) / len(page_metrics)
    max_rms = max(m['rmsDiffPct'] for m in page_metrics)
    non_zero_pages = [m['page'] for m in page_metrics if m['meanAbsDiffPct'] > 0 or m['rmsDiffPct'] > 0]

    return {
        'sourceManifest': pair.source_manifest,
        'publicationId': pair.publication_id,
        'publicationTitle': pair.publication_title,
        'processedAt': pair.processed_at,
        'finalScore': pair.final_score,
        'originalPdfPath': pair.original_pdf_path,
        'remediatedPdfPath': pair.remediated_pdf_path,
        'pageCountExpected': pair.page_count,
        'pageCountOriginalRendered': len(original_renders),
        'pageCountRemediatedRendered': len(remediated_renders),
        'classification': classify_pair(avg_mean, max_rms),
        'avgMeanAbsDiffPct': round(avg_mean, 6),
        'avgRmsDiffPct': round(avg_rms, 6),
        'maxRmsDiffPct': round(max_rms, 6),
        'nonZeroDiffPages': non_zero_pages,
        'pageMetrics': page_metrics,
    }


def main() -> None:
    pairs = load_pairs()
    workspace = Path(tempfile.mkdtemp(prefix='pdf-visual-parity-79-down-80-plus-'))
    results: list[dict[str, Any]] = []
    try:
        for index, pair in enumerate(pairs, start=1):
            results.append(audit_pair(pair, workspace))
            if index % 10 == 0 or index == len(pairs):
                print(json.dumps({'progress': index, 'total': len(pairs)}, separators=(',', ':')))
    finally:
        shutil.rmtree(workspace, ignore_errors=True)

    exact_matches = [row for row in results if row['classification'] == 'exact_visual_match']
    non_zero_rows = [row for row in results if row['classification'] != 'exact_visual_match']
    summary = {
        'generatedAt': __import__('datetime').datetime.utcnow().isoformat() + 'Z',
        'renderDpi': RENDER_DPI,
        'manifestPath': str(MANIFEST_PATH),
        'totalPairsAudited': len(results),
        'exactVisualMatches': len(exact_matches),
        'nonZeroDiffPairs': len(non_zero_rows),
        'materialChangePairs': len([row for row in results if row['classification'] == 'material_change_check_manually']),
        'minorVisibleChangePairs': len([row for row in results if row['classification'] == 'minor_visible_change']),
        'nonZeroButVisuallyClosePairs': len([row for row in results if row['classification'] == 'non_zero_but_visually_close']),
        'pageCountMismatchPairs': len([row for row in results if row['classification'] == 'page_count_mismatch_check_manually']),
        'nonZeroDiffPublicationIds': [row['publicationId'] for row in non_zero_rows],
    }
    detail_doc = {
        'generatedAt': summary['generatedAt'],
        'renderDpi': RENDER_DPI,
        'manifestPath': str(MANIFEST_PATH),
        'pairs': results,
    }
    write_json(DETAIL_PATH, detail_doc)
    write_json(SUMMARY_PATH, summary)
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
