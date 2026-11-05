---
field_id: malo_ex5_de05dd02d_1
prompt: "Does the chart document: typical exposure?"
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: ex5
polarity: exclusion
source_trait_id: "de05dd02d/1"
source_criterion_id: EX5
---

# Trait: typical exposure

## Protocol criterion this trait came from

**EX5** (exclusion), verbatim:

> Evidence of other forms of chronic liver disease including but not limited to
>  alcoholic liver disease
>  Hepatitis B as defined by the presence of hepatitis B surface antigen
>  Hepatitis C as defined by the presence of hepatitis C virus RNA
> Note: Participants who have been treated for hepatitis C and are confirmed
> cured are eligible if they have a negative hepatitis C RNA test for at least
> 2 years prior to screening.
>  history of primary biliary cholangitis
>  primary sclerosing cholangitis
>  autoimmune liver disease
>  hemochromatosis
>  Wilson’s disease
>  Alpha-1-antitrypsin-related liver disease
>  current drug-induced liver disease as defined based on typical exposure and
> history, and
>  any other type of liver disease other than MASLD.

## How to answer

Answer only this trait. Use the criterion text above, and any definition
above, as context for what the words mean — not as extra conditions to check.

No decision rules have been written for this trait. If it turns on a term the
protocol does not define, record the chart's own wording in `rationale` and
answer `unknown` rather than applying a threshold of your own.
