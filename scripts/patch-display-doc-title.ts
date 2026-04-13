/**
 * Targeted patch for PDFs stuck only on pdfua.display_doc_title.
 * Loads each remediated PDF, sets /Info /Title + ViewerPreferences/DisplayDocTitle,
 * re-analyzes to confirm Grade A, then stages for replacement and adds to ledger.
 *
 * Usage: pnpm exec tsx scripts/patch-display-doc-title.ts
 */
import path from 'path'
import fs from 'fs'
import { PDFDocument, PDFName, PDFBool, PDFHexString } from 'pdf-lib'
import { analyzePdf } from '../apps/api/src/engine/index.js'
import { evaluatePromotionGate } from '../apps/api/src/services/promotionGate.js'
import { appendToPromotionLedger } from '../apps/api/src/services/promotionLedger.js'

const TARGETS: Array<{ publicationId: string; title: string; remediatedPdfPath: string; serverHost: string; remotePath: string; fileUrl: string; storageKind: string }> = [
  {
    publicationId: '3768',
    title: 'Supervising sex offenders in DuPage Lake and Winnebago counties',
    remediatedPdfPath: '/home/hendo420/pdfaf/ICJIA-PDFs/artifacts/remediated-pdfs/stage4-structure-wave/143.244.146.43/3768-Supervising_sex_offenders_in_DuPage_Lake_and_Winnebago_counties.pdf',
    serverHost: '143.244.146.43',
    remotePath: '/home/forge/archive.icjia-api.cloud/root/files/icjia/pdf/Bulletins/sso01.pdf',
    fileUrl: 'https://archive.icjia-api.cloud/files/icjia/pdf/Bulletins/sso01.pdf',
    storageKind: 'legacy_archive',
  },
  {
    publicationId: '3770',
    title: 'Specialized Unit Takes a Problemsolving Approach to Crime in Kankakee',
    remediatedPdfPath: '/home/hendo420/pdfaf/ICJIA-PDFs/artifacts/remediated-pdfs/stage4-structure-wave/143.244.146.43/3770-Specialized_Unit_Takes_a_Problemsolving_Approachto_Crime_in_Kankakee.pdf',
    serverHost: '143.244.146.43',
    remotePath: '/home/forge/archive.icjia-api.cloud/root/files/icjia/pdf/Bulletins/ssu.pdf',
    fileUrl: 'https://archive.icjia-api.cloud/files/icjia/pdf/Bulletins/ssu.pdf',
    storageKind: 'legacy_archive',
  },
  {
    publicationId: '3670',
    title: 'Violent Crime Task Force Cracks Tough Homicide Cases in Kankakee County',
    remediatedPdfPath: '/home/hendo420/pdfaf/ICJIA-PDFs/artifacts/remediated-pdfs/stage4-structure-wave/143.244.146.43/3670-Violent_Crime_Task_Force_Cracks_Tough_Homicide_Cases_in_Kankakee_County.pdf',
    serverHost: '143.244.146.43',
    remotePath: '/home/forge/archive.icjia-api.cloud/root/files/icjia/pdf/Bulletins/vctf.pdf',
    fileUrl: 'https://archive.icjia-api.cloud/files/icjia/pdf/Bulletins/vctf.pdf',
    storageKind: 'legacy_archive',
  },
  {
    publicationId: '3665',
    title: 'Only Half of Reportable Cook County Court Dispositions on Rap Sheets',
    remediatedPdfPath: '/home/hendo420/pdfaf/ICJIA-PDFs/artifacts/remediated-pdfs/stage4-structure-wave/143.244.146.43/3665-Only_Half_of_Reportable_Cook_County_Court_Dispositions_on_Rap_Sheets.pdf',
    serverHost: '143.244.146.43',
    remotePath: '/home/forge/archive.icjia-api.cloud/root/files/icjia/pdf/Bulletins/rapsheets.pdf',
    fileUrl: 'https://archive.icjia-api.cloud/files/icjia/pdf/Bulletins/rapsheets.pdf',
    storageKind: 'legacy_archive',
  },
  {
    publicationId: '3784',
    title: 'Probation Research: Results of the 2000 Illinois Probation Outcome Study',
    remediatedPdfPath: '/home/hendo420/pdfaf/ICJIA-PDFs/artifacts/remediated-pdfs/stage4-structure-wave/143.244.146.43/3784-Probation_Research_Results_of_the_2000_Illinois_Probation_Outcome_Study.pdf',
    serverHost: '143.244.146.43',
    remotePath: '/home/forge/archive.icjia-api.cloud/root/files/icjia/pdf/Bulletins/proboutcomes.pdf',
    fileUrl: 'https://archive.icjia-api.cloud/files/icjia/pdf/Bulletins/proboutcomes.pdf',
    storageKind: 'legacy_archive',
  },
  {
    publicationId: '3769',
    title: 'Supervising Sex Offenders in Coles Madison and Vermilion Counties',
    remediatedPdfPath: '/home/hendo420/pdfaf/ICJIA-PDFs/artifacts/remediated-pdfs/stage4-structure-wave/143.244.146.43/3769-Supervising_Sex_Offenders_in_Coles_Madison_and_Vermilion_Counties.pdf',
    serverHost: '143.244.146.43',
    remotePath: '/home/forge/archive.icjia-api.cloud/root/files/icjia/pdf/Bulletins/sso02.pdf',
    fileUrl: 'https://archive.icjia-api.cloud/files/icjia/pdf/Bulletins/sso02.pdf',
    storageKind: 'legacy_archive',
  },
  {
    publicationId: '3683',
    title: 'Controlling Gang and Drug House Nuisances in Chicago',
    remediatedPdfPath: '/home/hendo420/pdfaf/ICJIA-PDFs/artifacts/remediated-pdfs/stage4-structure-wave/143.244.146.43/3683-Controlling_Gang_and_Drug_House_Nuisances_in_Chicago.pdf',
    serverHost: '143.244.146.43',
    remotePath: '/home/forge/archive.icjia-api.cloud/root/files/icjia/pdf/Bulletins/gangdrug.pdf',
    fileUrl: 'https://archive.icjia-api.cloud/files/icjia/pdf/Bulletins/gangdrug.pdf',
    storageKind: 'legacy_archive',
  },
]

async function patchTitle(buffer: Buffer, title: string): Promise<Buffer> {
  const pdfDoc = await PDFDocument.load(buffer, { updateMetadata: false, ignoreEncryption: true })
  pdfDoc.setTitle(title, { showInWindowTitleBar: true })
  const viewerPreferences = pdfDoc.catalog.lookup(PDFName.of('ViewerPreferences'), Object as any) || pdfDoc.context.obj({})
  ;(viewerPreferences as any).set(PDFName.of('DisplayDocTitle'), PDFBool.True)
  pdfDoc.catalog.set(PDFName.of('ViewerPreferences'), viewerPreferences as any)
  const infoRef = pdfDoc.context.trailerInfo.Info as any
  const info = infoRef ? pdfDoc.context.lookup(infoRef, Object as any) : pdfDoc.context.obj({})
  ;(info as any).set(PDFName.of('Title'), PDFHexString.fromText(title))
  if (!infoRef) {
    pdfDoc.context.trailerInfo.Info = pdfDoc.context.register(info as any) as any
  }
  return Buffer.from(await pdfDoc.save())
}

async function main() {
  const stagingRoot = '/home/hendo420/pdfaf/ICJIA-PDFs/staging/to-replace'
  const artifactsRoot = '/home/hendo420/pdfaf/ICJIA-PDFs/artifacts/remediated-pdfs/title-patch'

  let passed = 0
  let failed = 0

  for (const target of TARGETS) {
    console.log(`\n[${target.publicationId}] ${target.title.slice(0, 60)}`)

    if (!fs.existsSync(target.remediatedPdfPath)) {
      console.log(`  SKIP: remediated PDF not found at ${target.remediatedPdfPath}`)
      failed++
      continue
    }

    const original = fs.readFileSync(target.remediatedPdfPath)
    let patched: Buffer
    try {
      patched = await patchTitle(original, target.title)
    } catch (err) {
      console.log(`  ERROR patching title: ${err}`)
      failed++
      continue
    }

    // Re-analyze
    let analysis: Awaited<ReturnType<typeof analyzePdf>>
    try {
      analysis = await analyzePdf(patched, path.basename(target.remediatedPdfPath))
    } catch (err) {
      console.log(`  ERROR analyzing: ${err}`)
      failed++
      continue
    }

    const gate = evaluatePromotionGate(analysis)
    console.log(`  Score: ${analysis.overallScore} Grade: ${analysis.grade} Gate: ${gate.passed ? 'PASS' : 'FAIL'}`)
    if (!gate.passed) {
      console.log(`  Gate reasons: ${gate.reasons.join('; ')}`)
      failed++
      continue
    }

    // Save patched artifact
    const artifactDir = path.join(artifactsRoot, target.serverHost)
    fs.mkdirSync(artifactDir, { recursive: true })
    const artifactFilename = path.basename(target.remediatedPdfPath)
    const artifactPath = path.join(artifactDir, artifactFilename)
    fs.writeFileSync(artifactPath, patched)

    // Stage for replacement
    const remoteDir = path.dirname(target.remotePath)
    const stagingDir = path.join(stagingRoot, target.serverHost, remoteDir.replace(/^\//, ''))
    fs.mkdirSync(stagingDir, { recursive: true })
    const stagingPath = path.join(stagingDir, path.basename(target.remotePath))
    fs.writeFileSync(stagingPath, patched)

    // Add to promotion ledger
    try {
      await appendToPromotionLedger({
        publicationId: target.publicationId,
        publicationTitle: target.title,
        sourceKind: 'batch_ready',
        sourcePathOrUrl: target.remotePath,
        sourceFileUrl: target.fileUrl,
        localFinalArtifactPath: artifactPath,
        stagedReplacementPath: stagingPath,
        verificationSummary: {
          passed: true,
          overallScore: analysis.overallScore,
          grade: analysis.grade,
          pageCount: analysis.pageCount,
          isScanned: analysis.isScanned ?? false,
          reasons: [],
          blockingLocalFindingKeys: [],
          unresolvedCategoryLabels: [],
          criticalManualReviewFlagCodes: [],
        },
      })
      console.log(`  ✓ Promoted to ledger, staged at ${stagingPath}`)
      passed++
    } catch (err) {
      console.log(`  ERROR adding to ledger: ${err}`)
      failed++
    }
  }

  console.log(`\nDone: ${passed} passed, ${failed} failed`)
}

main().catch(err => { console.error(err); process.exit(1) })
