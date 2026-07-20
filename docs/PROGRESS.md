# Chart-Review Platform — Progress Update



## 1. Where each project stands


| Project | Review type | Status |
|---|---|---|
| RUCAM | Phenotype | ✅ Verified end-to-end (real patient data) |
| Lung cancer | Guideline concordance | ✅ Verified end-to-end (real patient data) |
| CONCUR | Phenotype | 🔄 In progress (cancer, ECOG) |
| Depression | Phenotype | 🔄 In progress |
| BSO-AD | Entity extraction (NER) | 🔄 In progress |
| ACTS | Phenotype | 🔄 In progress |
| Asthma | Guideline concordance | ⏳ Pending |

---

## 2. Features tested and worked

| Feature | What it does |
|---|---|
| **Self-improving guideline/rubric** | First do error analyzes where the AI disagreed with the human and why, then turns that into a clearer guideline — each change checked and reversible. |
| **Guideline/rubric version management** | Save, switch, undo, or publish versions of the guideline. |
| **Per-task tool control** | Choose which tools each task's AI can use to find evidence. |

---

## 3. Next

- **Comprehensive testing across AI settings** — run the reviews under different
  models, search settings, and numbers of reviewers to find what's most accurate
  and reliable.
- **Token-cost optimization** — bring down the cost per review (shorter prompts,
  caching, fewer or cheaper model calls) without losing accuracy.
- **Feature-complete internal build** (performance evaluation + providers):
  targeting **_July 2026_**.

