export interface ProcessedRegressionPair {
  beforeFilename: string
  afterFilename: string
}

export interface ProcessedRegressionManifest {
  beforeDir: string
  afterDir: string
  expectedAfterScore: number
  expectedAfterGrade: string
  pairs: ProcessedRegressionPair[]
  knownMissingAfter: string[]
}

export const PROCESSED_REGRESSION_MANIFEST: ProcessedRegressionManifest = {
  beforeDir: 'Processed/Before',
  afterDir: 'Processed/After',
  expectedAfterScore: 100,
  expectedAfterGrade: 'A',
  pairs: [
    { beforeFilename: '04-07MVStrategy.pdf', afterFilename: '04-07MVStrategy.pdf' },
    { beforeFilename: '10drug arrests_1999-2008.pdf', afterFilename: '10drug_arrests_1999-2008.pdf' },
    { beforeFilename: '11drug seizures_1997-2007.pdf', afterFilename: '11drug_seizures_1997-2007.pdf' },
    { beforeFilename: '12drug submissions_1997-2007.pdf', afterFilename: '12drug_submissions_1997-2007.pdf' },
    { beforeFilename: '13drug treatment_1999-2008.pdf', afterFilename: '13drug_treatment_1999-2008.pdf' },
    { beforeFilename: '14felony and misdemeanor filings_1999-2008.pdf', afterFilename: '14felony_and_misdemeanor_filings_1999-2008.pdf' },
    { beforeFilename: '15adult probation_1999-2008.pdf', afterFilename: '15adult_probation_1999-2008.pdf' },
    { beforeFilename: '1988-1989 Biennial Report.pdf', afterFilename: '1988-1989_Biennial_Report.pdf' },
    { beforeFilename: '1993-1994 Biennial Report.pdf', afterFilename: '1993-1994_Biennial_Report.pdf' },
    { beforeFilename: '1996CHRIAudit.pdf', afterFilename: '1996CHRIAudit.pdf' },
    { beforeFilename: '1998 Madison.pdf', afterFilename: '1998_Madison.pdf' },
    { beforeFilename: '2000AnnualReport.pdf', afterFilename: '2000AnnualReport.pdf' },
    { beforeFilename: '2000Probation Outcome Study.pdf', afterFilename: '2000Probation_Outcome_Study.pdf' },
    { beforeFilename: '2001 MV Annual Report.pdf', afterFilename: '2001_MV_Annual_Report.pdf' },
    { beforeFilename: '2003CHRIAudit.pdf', afterFilename: '2003CHRIAudit.pdf' },
    { beforeFilename: '2004MEGTFSummary.pdf', afterFilename: '2004MEGTFSummary.pdf' },
    { beforeFilename: '2006 Annual Report.pdf', afterFilename: '2006 Annual Report.pdf' },
    { beforeFilename: '2009 MV Annual Report.pdf', afterFilename: '2009 MV Annual Report.pdf' },
    { beforeFilename: '4violent arrests_1999-2008.pdf', afterFilename: '4violent_arrests_1999-2008.pdf' },
    { beforeFilename: '5property offenses_1999-2008.pdf', afterFilename: '5property_offenses_1999-2008.pdf' },
    { beforeFilename: '6property arrests_1999-2008.pdf', afterFilename: '6property_arrests_1999-2008.pdf' },
    { beforeFilename: '7domestic offenses_1999-2008.pdf', afterFilename: '7domestic_offenses_1999-2008.pdf' },
    { beforeFilename: '8child abuse_1997-2007.pdf', afterFilename: '8child_abuse_1997-2007.pdf' },
    { beforeFilename: '97anreport.pdf', afterFilename: '97anreport.pdf' },
    { beforeFilename: '98anreport.pdf', afterFilename: '98anreport.pdf' },
    { beforeFilename: '99anreport.pdf', afterFilename: '99anreport.pdf' },
    { beforeFilename: '9elder abuse_2000-2009.pdf', afterFilename: '9elder_abuse_2000-2009.pdf' },
  ],
  knownMissingAfter: [
    '1total offenses_1999-2008.pdf',
    '2total arrests_1999-2008.pdf',
    '3violent offenses_1999-2008.pdf',
  ],
}
