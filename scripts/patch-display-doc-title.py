#!/usr/bin/env python3
"""
Targeted patch for PDFs stuck only on pdfua.display_doc_title.
Sets /Info /Title and ViewerPreferences /DisplayDocTitle on already-remediated PDFs,
saves to staging paths, then updates the outcomes manifest so verify-ready picks them up.

After this script runs:
  pnpm agency:verify-ready
  pnpm exec tsx scripts/classify-ready-verification.ts
  pnpm agency:build-control-plane
  pnpm agency:validate-control-plane

Usage: python3 scripts/patch-display-doc-title.py
"""
import os
import json
import datetime
import pikepdf

REPO_ROOT = '/home/hendo420/pdfaf'
ICJIA_ROOT = os.path.join(REPO_ROOT, 'ICJIA-PDFs')
STAGING_ROOT = os.path.join(ICJIA_ROOT, 'staging', 'to-replace')
ARTIFACTS_ROOT = os.path.join(ICJIA_ROOT, 'artifacts', 'remediated-pdfs', 'title-patch')
MANIFESTS_ROOT = os.path.join(ICJIA_ROOT, 'manifests')

TARGETS = [
    {
        'publicationId': '3768',
        'publicationTitle': 'Supervising sex offenders in DuPage Lake and Winnebago counties',
        'serverHost': '143.244.146.43',
        'remotePath': '/home/forge/archive.icjia-api.cloud/root/files/icjia/pdf/oga/sexoffogaPDF.pdf',
        'fileUrl': 'https://archive.icjia-api.cloud/files/icjia/pdf/oga/sexoffogaPDF.pdf',
        'remediatedPdfPath': os.path.join(ICJIA_ROOT, 'artifacts/remediated-pdfs/stage4-structure-wave/143.244.146.43/3768-Supervising_sex_offenders_in_DuPage_Lake_and_Winnebago_counties.pdf'),
    },
    {
        'publicationId': '3770',
        'publicationTitle': 'Specialized Unit Takes a Problem-Solving Approach to Crime in Kankakee',
        'serverHost': '143.244.146.43',
        'remotePath': '/home/forge/archive.icjia-api.cloud/root/files/icjia/pdf/oga/kmegoga.pdf',
        'fileUrl': 'https://archive.icjia-api.cloud/files/icjia/pdf/oga/kmegoga.pdf',
        'remediatedPdfPath': os.path.join(ICJIA_ROOT, 'artifacts/remediated-pdfs/stage4-structure-wave/143.244.146.43/3770-Specialized_Unit_Takes_a_Problemsolving_Approachto_Crime_in_Kankakee.pdf'),
    },
    {
        'publicationId': '3670',
        'publicationTitle': 'Violent Crime Task Force Cracks Tough Homicide Cases in Kankakee County',
        'serverHost': '143.244.146.43',
        'remotePath': '/home/forge/archive.icjia-api.cloud/root/files/icjia/pdf/oga/VCTFOGA.pdf',
        'fileUrl': 'https://archive.icjia-api.cloud/files/icjia/pdf/oga/VCTFOGA.pdf',
        'remediatedPdfPath': os.path.join(ICJIA_ROOT, 'artifacts/remediated-pdfs/stage4-structure-wave/143.244.146.43/3670-Violent_Crime_Task_Force_Cracks_Tough_Homicide_Cases_in_Kankakee_County.pdf'),
    },
    {
        'publicationId': '3665',
        'publicationTitle': 'Only Half of Reportable Cook County Court Dispositions on Rap Sheets',
        'serverHost': '143.244.146.43',
        'remotePath': '/home/forge/archive.icjia-api.cloud/root/files/icjia/pdf/oga/CCH.pdf',
        'fileUrl': 'https://archive.icjia-api.cloud/files/icjia/pdf/oga/CCH.pdf',
        'remediatedPdfPath': os.path.join(ICJIA_ROOT, 'artifacts/remediated-pdfs/stage4-structure-wave/143.244.146.43/3665-Only_Half_of_Reportable_Cook_County_Court_Dispositions_on_Rap_Sheets.pdf'),
    },
    {
        'publicationId': '3784',
        'publicationTitle': 'Probation Research: Results of the 2000 Illinois Probation Outcome Study',
        'serverHost': '143.244.146.43',
        'remotePath': '/home/forge/archive.icjia-api.cloud/root/files/icjia/pdf/oga/probation.pdf',
        'fileUrl': 'https://archive.icjia-api.cloud/files/icjia/pdf/oga/probation.pdf',
        'remediatedPdfPath': os.path.join(ICJIA_ROOT, 'artifacts/remediated-pdfs/stage4-structure-wave/143.244.146.43/3784-Probation_Research_Results_of_the_2000_Illinois_Probation_Outcome_Study.pdf'),
    },
    {
        'publicationId': '3769',
        'publicationTitle': 'Supervising Sex Offenders in Coles Madison and Vermilion Counties',
        'serverHost': '143.244.146.43',
        'remotePath': '/home/forge/archive.icjia-api.cloud/root/files/icjia/pdf/oga/CMVoga.pdf',
        'fileUrl': 'https://archive.icjia-api.cloud/files/icjia/pdf/oga/CMVoga.pdf',
        'remediatedPdfPath': os.path.join(ICJIA_ROOT, 'artifacts/remediated-pdfs/stage4-structure-wave/143.244.146.43/3769-Supervising_Sex_Offenders_in_Coles_Madison_and_Vermilion_Counties.pdf'),
    },
    {
        'publicationId': '3683',
        'publicationTitle': 'Controlling Gang and Drug House Nuisances in Chicago',
        'serverHost': '143.244.146.43',
        'remotePath': '/home/forge/archive.icjia-api.cloud/root/files/icjia/pdf/oga/abateOGA.pdf',
        'fileUrl': 'https://archive.icjia-api.cloud/files/icjia/pdf/oga/abateOGA.pdf',
        'remediatedPdfPath': os.path.join(ICJIA_ROOT, 'artifacts/remediated-pdfs/stage4-structure-wave/143.244.146.43/3683-Controlling_Gang_and_Drug_House_Nuisances_in_Chicago.pdf'),
    },
]


def patch_title_and_display(input_path, output_path, title):
    """Set /Info /Title and ViewerPreferences /DisplayDocTitle using pikepdf."""
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with pikepdf.open(input_path) as pdf:
        # Set /Info /Title
        if '/Info' not in pdf.trailer:
            pdf.trailer['/Info'] = pdf.make_indirect(pikepdf.Dictionary())
        info = pdf.trailer['/Info']
        info['/Title'] = pikepdf.String(title)

        # Set ViewerPreferences /DisplayDocTitle
        catalog = pdf.Root
        if '/ViewerPreferences' not in catalog:
            catalog['/ViewerPreferences'] = pdf.make_indirect(pikepdf.Dictionary())
        vp = catalog['/ViewerPreferences']
        vp['/DisplayDocTitle'] = True

        pdf.save(output_path)


def load_json(path):
    with open(path) as f:
        return json.load(f)


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        json.dump(data, f, indent=2)
        f.write('\n')


def main():
    outcomes_path = os.path.join(MANIFESTS_ROOT, 'stage4-structure-wave.outcomes.json')
    outcomes_doc = load_json(outcomes_path)
    outcomes = outcomes_doc.get('outcomes', [])
    outcomes_by_pub = {str(r.get('publicationId')): (i, r) for i, r in enumerate(outcomes)}

    target_ids = set(t['publicationId'] for t in TARGETS)
    patched = []
    skipped = []

    for t in TARGETS:
        pub_id = t['publicationId']
        title = t['publicationTitle']
        input_path = t['remediatedPdfPath']

        print(f'\n[{pub_id}] {title[:60]}')

        if not os.path.exists(input_path):
            print(f'  SKIP: remediated PDF not found: {input_path}')
            skipped.append(pub_id)
            continue

        # Build artifact + staging paths
        artifact_dir = os.path.join(ARTIFACTS_ROOT, t['serverHost'])
        artifact_filename = os.path.basename(input_path)
        artifact_path = os.path.join(artifact_dir, artifact_filename)

        remote_rel = t['remotePath'].lstrip('/')
        staging_path = os.path.join(STAGING_ROOT, t['serverHost'], remote_rel)

        try:
            patch_title_and_display(input_path, artifact_path, title)
            patch_title_and_display(input_path, staging_path, title)
            print(f'  Patched → {artifact_path}')
            print(f'  Staged  → {staging_path}')
        except Exception as e:
            print(f'  ERROR patching: {e}')
            skipped.append(pub_id)
            continue

        # Update the outcomes row to ready_to_replace so verify-ready picks it up
        if pub_id in outcomes_by_pub:
            idx, row = outcomes_by_pub[pub_id]
            row['status'] = 'ready_to_replace'
            if not row.get('artifacts'):
                row['artifacts'] = {}
            row['artifacts']['remediatedPdfPath'] = artifact_path
            row['artifacts']['stagedReplacementPath'] = staging_path
            row['promotionStatus'] = 'staged_for_replacement'
            outcomes[idx] = row
            print(f'  Updated outcome row to ready_to_replace')
        else:
            # Insert new row
            ts = datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S.000Z')
            new_row = {
                'publicationId': pub_id,
                'publicationTitle': title,
                'serverHost': t['serverHost'],
                'remotePath': t['remotePath'],
                'fileUrl': t['fileUrl'],
                'status': 'ready_to_replace',
                'processedAt': ts,
                'artifacts': {
                    'remediatedPdfPath': artifact_path,
                    'stagedReplacementPath': staging_path,
                },
                'promotionStatus': 'staged_for_replacement',
            }
            outcomes.append(new_row)
            print(f'  Inserted new outcome row as ready_to_replace')

        patched.append(pub_id)

    if patched:
        outcomes_doc['outcomes'] = outcomes
        outcomes_doc['totals']['readyToReplace'] = outcomes_doc['totals'].get('readyToReplace', 0) + len(patched)
        outcomes_doc['totals']['failedAfterRemediation'] = max(0, outcomes_doc['totals'].get('failedAfterRemediation', 0) - len(patched))
        write_json(outcomes_path, outcomes_doc)
        print(f'\n✓ Outcomes manifest updated: {len(patched)} rows marked ready_to_replace')
        print(f'\nNext steps:')
        print(f'  pnpm agency:verify-ready')
        print(f'  pnpm exec tsx scripts/classify-ready-verification.ts')
        print(f'  pnpm agency:build-control-plane')
        print(f'  pnpm agency:validate-control-plane')
    else:
        print('\nNo PDFs patched.')

    print(f'\nPatched: {patched}')
    print(f'Skipped: {skipped}')


if __name__ == '__main__':
    main()
