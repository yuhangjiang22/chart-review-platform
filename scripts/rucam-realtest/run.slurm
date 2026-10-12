#!/bin/bash
# RUCAM validation batch on the on-prem PHI vLLM lane (Qwen3.8-27B-FP8).
# Modeled on scripts/phi-vllm/pilot.slurm; differs in three ways:
#   * drives scripts/rucam-realtest/run.ts instead of the LCN driver;
#   * defaults PHI_EP_FILE to the RUCAM-dedicated side server ($P/endpoint_rucam)
#     so this does not contend with the LCN session on the main phi_vllm_srv;
#   * points CHART_REVIEW_RUCAM_DATA_DIR at the shadow data dir, whose notes/
#     holds the gold patients' materialized .txt (rucam_tools.search_notes reads
#     <data_dir>/notes/<person_id>/, NOT the corpus fixture — without it the
#     agent scores a blank chart and "completes" with junk).
#
# Usage: sbatch scripts/rucam-realtest/run.slurm [patient_id ...]   (no args = all 6)
# Optional env (sbatch --export=ALL,...): PHI_EP_FILE, PHI_VLLM_SAMPLING,
# RUN_CONCURRENCY (default 1), RUN_MAX_TURNS, CHART_REVIEW_RUCAM_DATA_DIR.
#SBATCH --job-name=rucam_phi
#SBATCH --account=r01682
#SBATCH --partition=general
#SBATCH --time=1-00:00:00
#SBATCH --cpus-per-task=4
#SBATCH --mem=32G
#SBATCH --output=/N/project/cancer_immu_registry/yji_chart_review_platform/phi_vllm/rucam/logs/rucam_%j.out
set -euo pipefail
P=/N/project/cancer_immu_registry/yji_chart_review_platform/phi_vllm
PLAT=$(dirname $P)/chart-review-platform
cd $PLAT

EPF=${PHI_EP_FILE:-$P/endpoint_rucam}
if [ -f "$EPF" ]; then EP=$(cut -d' ' -f2 "$EPF"); export PHI_VLLM_BASE_URL=$EP
else EP=$(grep '^PHI_VLLM_BASE_URL=' .env | cut -d= -f2-); echo "[rucam] $EPF absent — falling back to .env"; fi
[ -n "$EP" ] || { echo "FATAL: no PHI endpoint — start serve.slurm first"; exit 1; }
case "$EP" in http://g*|http://c*) ;; *) echo "FATAL: PHI endpoint $EP is not a Quartz node"; exit 1;; esac
KEY=$(grep '^PHI_VLLM_API_KEY=' .env | cut -d= -f2-)
curl -s -m 10 -H "Authorization: Bearer $KEY" "$EP/models" | grep -q phi-model || { echo "FATAL: $EP not answering"; exit 1; }

export CHART_REVIEW_RUCAM_DATA_DIR=${CHART_REVIEW_RUCAM_DATA_DIR:-$P/rucam/data_v3}
export RUN_CONCURRENCY=${RUN_CONCURRENCY:-1}
# run.ts exits (killing the batch mid-patient) at RUN_DEADLINE_MIN; its 90 default
# is a GPT-era figure. Keep it just under the Slurm walltime — advisory, per CLAUDE.md.
export RUN_DEADLINE_MIN=${RUN_DEADLINE_MIN:-1380}
export DEEPAGENTS_USAGE_LOG=${DEEPAGENTS_USAGE_LOG:-$P/rucam/usage_${SLURM_JOB_ID}.jsonl}
[ -d "$CHART_REVIEW_RUCAM_DATA_DIR/notes" ] || { echo "FATAL: no notes/ under $CHART_REVIEW_RUCAM_DATA_DIR"; exit 1; }

module load nodejs/20.4.0
echo "[rucam] endpoint $EP  data_dir=$CHART_REVIEW_RUCAM_DATA_DIR  concurrency=$RUN_CONCURRENCY"
echo "[rucam] patients: ${*:-<all patient_real_rucam_*>}"
node_modules/.bin/tsx scripts/rucam-realtest/run.ts "$@"
