---
field_id: vascular_disease_present
prompt: Does the patient have documented vascular disease — prior MI, peripheral artery disease, or aortic plaque?
answer_schema:
  type: enum
  enum: ["yes", "no"]
is_final_output: false
time_window: lookback_lifetime
---

## Definition

Any of the three vascular-disease components per Lip 2010:
1. Prior myocardial infarction (any subtype, STEMI / NSTEMI)
2. Peripheral artery disease (claudication, PAD with ABI ≤0.9, prior
   peripheral revascularization, or amputation for PAD)
3. Aortic plaque (complex aortic atheroma on imaging, ≥4mm thickness or
   mobile / ulcerated)

Stable coronary artery disease without prior MI does NOT qualify.

## Extraction guidance

- Problem list / encounter ICD-10:
  - I21.x or I22.x — current/subsequent MI
  - I25.2 — old MI / history of MI
  - I70.2x — atherosclerosis of native arteries (PAD with claudication)
  - I73.9 — peripheral vascular disease unspecified
- Procedure history: prior PCI/CABG (only if the indication was MI, not stable
  angina alone), peripheral angioplasty, lower-extremity bypass
- Imaging: TEE or CT showing complex aortic plaque ≥4mm
- Provider notes: "h/o MI", "prior STEMI", "PAD on cilostazol", "peripheral
  bypass 2019"

## Examples

**Satisfying:**
- "PMH: STEMI 2020, s/p PCI to LAD"
- ICD-10 I25.2 (old MI) on the problem list
- "PAD with bilateral claudication, ABI 0.7"
- "TEE: complex 5mm mobile plaque in descending aorta"

**Non-satisfying:**
- "Stable angina, last cath 2019 showed 50% LAD lesion, medical management"
  (no MI documented)
- Carotid stenosis without symptoms or revascularization
- "ASCVD risk 12%" (a calculator output, not a diagnosis)

## Boundary / failure modes

- "Type 2 MI from sepsis-induced demand ischemia" → "yes" (still an MI per
  Universal Definition)
- Coronary atherosclerosis without MI → "no"
- Aortic aneurysm without plaque → "no" (the criterion is plaque, not aneurysm)
- "h/o angina" → check for MI documentation; angina alone is "no"
