# Test data and sample PDF locations

## ICJIA publication originals (99anreport and others)

The original PDFs used for regression testing (e.g. **99anreport.pdf**, “Other elements alternate text” / H2 `/Alt` case) live in the **file-accessibility-audit** repo, not in this repo:

- **Repo:** [ICJIA/file-accessibility-audit](https://github.com/ICJIA/file-accessibility-audit)
- **Path:** `downloads/icjia-publications/`
- **Example (Windows):**  
  `C:\Users\<user>\OneDrive\Documents\GitHub\file-accessibility-audit\downloads\icjia-publications`

To run a full **original → remediate** pipeline (e.g. for 99anreport), copy the desired PDF from that folder into this project or pass its path to your script. Queue-storage originals and rebuilt files in this repo are keyed by queue UUID and are not committed (see `.gitignore`).
