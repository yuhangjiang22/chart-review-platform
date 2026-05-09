---
name: codeset-lookup
description: Look up ICD-10, LOINC, CPT, and SNOMED-CT codes; expand a parent code to its descendant set; map between code systems. Use during chart review when validating a coded value or expanding a study's inclusion code list.
---

# Codeset Lookup

Maps natural-language clinical concepts to standardized codes and expands code hierarchies.

## How it works (today)

The platform's chart review agent uses MCP tools (`claude.ai ICD-10 Codes` server) for ICD-10 lookups. LOINC/CPT/SNOMED lookups are not yet implemented as platform code.

## Future externalization

Expand into a fully-self-contained skill once LOINC/CPT/SNOMED lookups are added. Out of scope for batch E.0.
