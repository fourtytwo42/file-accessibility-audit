export interface Phase0CorpusEntry {
  filename: string
  pdfPath: string
  adobeReportPath: string | null
  sourceSet: '3rdpass_pass' | '3rdpass_fail' | 'downloads'
}

export const PHASE0_BASELINE_CORPUS: Phase0CorpusEntry[] = [
  {
    filename: 'Addressing Police Stress FINAL-220523T17215932.pdf',
    pdfPath: '3rdPass/Pass/Addressing Police Stress FINAL-220523T17215932.pdf',
    adobeReportPath: '3rdPass/Reports/Addressing Police Stress FINAL-220523T17215932.pdf.accreport.html',
    sourceSet: '3rdpass_pass',
  },
  {
    filename: 'CMVoga.pdf',
    pdfPath: '3rdPass/Fail/CMVoga.pdf',
    adobeReportPath: '3rdPass/Reports/CMVoga.pdf.accreport.html',
    sourceSet: '3rdpass_fail',
  },
  {
    filename: 'Evaluation of the Lake County Adult Probation.pdf',
    pdfPath: '3rdPass/Fail/Evaluation of the Lake County Adult Probation.pdf',
    adobeReportPath: '3rdPass/Reports/Evaluation of the Lake County Adult Probation.pdf.accreport.html',
    sourceSet: '3rdpass_fail',
  },
  {
    filename: 'FINAL GUN HOMICIDE PDF-230610T15405729.pdf',
    pdfPath: '3rdPass/Fail/FINAL GUN HOMICIDE PDF-230610T15405729.pdf',
    adobeReportPath: '3rdPass/Reports/FINAL GUN HOMICIDE PDF-230610T15405729.pdf.accreport.html',
    sourceSet: '3rdpass_fail',
  },
  {
    filename: 'FINAL Lewd Sexual Display in Prison 2025 Annual Report-251222T18474645.pdf',
    pdfPath: '3rdPass/Fail/FINAL Lewd Sexual Display in Prison 2025 Annual Report-251222T18474645.pdf',
    adobeReportPath: '3rdPass/Reports/FINAL Lewd Sexual Display in Prison 2025 Annual Report-251222T18474645.pdf.accreport.html',
    sourceSet: '3rdpass_fail',
  },
  {
    filename: 'GTF-juvenilesentencing.pdf',
    pdfPath: '3rdPass/Fail/GTF-juvenilesentencing.pdf',
    adobeReportPath: '3rdPass/Reports/GTF-juvenilesentencing.pdf.accreport.html',
    sourceSet: '3rdpass_fail',
  },
  {
    filename: 'GTF_Juvenile_Criminal_Records_072011.pdf',
    pdfPath: '3rdPass/Fail/GTF_Juvenile_Criminal_Records_072011.pdf',
    adobeReportPath: '3rdPass/Reports/GTF_Juvenile_Criminal_Records_072011.pdf.accreport.html',
    sourceSet: '3rdpass_fail',
  },
  {
    filename: 'Greene-2.pdf',
    pdfPath: '3rdPass/Fail/Greene-2.pdf',
    adobeReportPath: '3rdPass/Reports/Greene-2.pdf.accreport.html',
    sourceSet: '3rdpass_fail',
  },
  {
    filename: 'Johnson-2.pdf',
    pdfPath: '3rdPass/Fail/Johnson-2.pdf',
    adobeReportPath: '3rdPass/Reports/Johnson-2.pdf.accreport.html',
    sourceSet: '3rdpass_fail',
  },
  {
    filename: 'Law Expands Access to Juv Justice Info.pdf',
    pdfPath: '3rdPass/Fail/Law Expands Access to Juv Justice Info.pdf',
    adobeReportPath: '3rdPass/Reports/Law Expands Access to Juv Justice Info.pdf.accreport.html',
    sourceSet: '3rdpass_fail',
  },
  {
    filename: 'McLean-2.pdf',
    pdfPath: '3rdPass/Fail/McLean-2.pdf',
    adobeReportPath: '3rdPass/Reports/McLean-2.pdf.accreport.html',
    sourceSet: '3rdpass_fail',
  },
  {
    filename: 'Prescription drug November 2008.pdf',
    pdfPath: '3rdPass/Fail/Prescription drug November 2008.pdf',
    adobeReportPath: '3rdPass/Reports/Prescription drug November 2008.pdf.accreport.html',
    sourceSet: '3rdpass_fail',
  },
  {
    filename: 'Redeploy Illinois Macon County.pdf',
    pdfPath: '3rdPass/Fail/Redeploy Illinois Macon County.pdf',
    adobeReportPath: '3rdPass/Reports/Redeploy Illinois Macon County.pdf.accreport.html',
    sourceSet: '3rdpass_fail',
  },
  {
    filename: 'SPTDVoga.pdf',
    pdfPath: '3rdPass/Fail/SPTDVoga.pdf',
    adobeReportPath: '3rdPass/Reports/SPTDVoga.pdf.accreport.html',
    sourceSet: '3rdpass_fail',
  },
  {
    filename: 'Southern Illinois Drug Task Force.pdf',
    pdfPath: '3rdPass/Fail/Southern Illinois Drug Task Force.pdf',
    adobeReportPath: '3rdPass/Reports/Southern Illinois Drug Task Force.pdf.accreport.html',
    sourceSet: '3rdpass_fail',
  },
  {
    filename: 'State criminal justice survey Sept 2007.pdf',
    pdfPath: '3rdPass/Fail/State criminal justice survey Sept 2007.pdf',
    adobeReportPath: '3rdPass/Reports/State criminal justice survey Sept 2007.pdf.accreport.html',
    sourceSet: '3rdpass_fail',
  },
  {
    filename: 'Traffic and Pedestrian Stop Data Use and Collection Task Force 2025 Report - FINAL 2-24-25-250328T14564559.pdf',
    pdfPath: '3rdPass/Fail/Traffic and Pedestrian Stop Data Use and Collection Task Force 2025 Report - FINAL 2-24-25-250328T14564559.pdf',
    adobeReportPath: '3rdPass/Reports/Traffic and Pedestrian Stop Data Use and Collection Task Force 2025 Report - FINAL 2-24-25-250328T14564559.pdf.accreport.html',
    sourceSet: '3rdpass_fail',
  },
  {
    filename: 'Wabash-2.pdf',
    pdfPath: '3rdPass/Fail/Wabash-2.pdf',
    adobeReportPath: '3rdPass/Reports/Wabash-2.pdf.accreport.html',
    sourceSet: '3rdpass_fail',
  },
  {
    filename: 'duifinal.pdf',
    pdfPath: '3rdPass/Fail/duifinal.pdf',
    adobeReportPath: '3rdPass/Reports/duifinal.pdf.accreport.html',
    sourceSet: '3rdpass_fail',
  },
  {
    filename: 'juv probation.pdf',
    pdfPath: '3rdPass/Fail/juv probation.pdf',
    adobeReportPath: '3rdPass/Reports/juv probation.pdf.accreport.html',
    sourceSet: '3rdpass_fail',
  },
  {
    filename: 'juvenile2000study.pdf',
    pdfPath: '3rdPass/Fail/juvenile2000study.pdf',
    adobeReportPath: '3rdPass/Reports/juvenile2000study.pdf.accreport.html',
    sourceSet: '3rdpass_fail',
  },
] as const
