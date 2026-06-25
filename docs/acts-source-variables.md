# ACTS source variable list (canonical)

Verbatim from `sources/unstructured entities for NLP_20260604.xlsx` (Sheet1) in github.com/xuguang-ai/acts @ b736b1f (2026-06-18). This is the upstream concept/variable list the ACTS rubric was built from.

| Concept | Type | Candidates | Note |
| --- | --- | --- | --- |
| Allergy/Hypersensitivity | Inf | It can be anything, please check this: https://build.fhir.org/ig/HL7/fhir-omop-ig/en/StructureMap-AllergyMap.html |  |
| APOE | Categorical | ApoE2, ApoE3, ApoE4 |  |
| Clinical_Dementia_Rating_Scale | Numeric |  |  |
| Cornell_Scale_For_Depression_In_Dementia | Numeric |  |  |
| Geriatric_Depression_Scale | Numeric |  |  |
| Hachinski_Ischemia_Score | Numeric |  |  |
| Mini-Mental_State_Examination_Score | Numeric |  |  |
| Montreal_Cognitive_Assessment_Score | Numeric |  |  |
| NPI_Total_Score | Numeric |  |  |
| Impaired_Cognition | Binary |  |  |
| Knowledge_Acquisition | Numeric | how many year of education |  |
| Smoking | Categorical/Numeric | more than 20 cigarettes per day (Numeric); smoking within a period (binary); never smoker |  |
| Infertility | Binary |  |  |
| Menstruation | Binary/date | includes: Postmenopause / Last Menstruation Date |  |
| Immunization | inf | active amyloid or tau immunization (i.e., vaccination for Alzheimer's disease); live vaccine; non-lie vaccine; BCG | live and non-live vaccine can be a lot, maybe we can extract the immunization history, and determine later |
| Mattis Dementia Rating Scale | Numeric |  |  |
| Global Deterioration Scale | Numeric |  |  |
| Telephone Interview of Cognitive Status (TICS) score | Numeric |  |  |
