#!/usr/bin/env bash
# Deploys the scheduled bank sync (server/src/syncJob.ts) to Google Cloud:
#
#   1. builds server/Dockerfile with Cloud Build and pushes it to Artifact
#      Registry (skip with IMAGE=<existing image>)
#   2. creates or updates the Cloud Run Job  takziv-sync-job, running as
#      takziv-sync (KMS decrypt only)
#   3. creates or updates the Cloud Scheduler trigger  takziv-daily-sync
#      (06:00 Asia/Jerusalem), which calls the Cloud Run Admin API as
#      takziv-scheduler, an account that may only run this one job
#
# Run infra/setup-kms.sh first (once, or again after it changes): it creates
# the KMS key and the takziv-sync account this job depends on.
#
#   bash infra/deploy-sync-job.sh               # from server/, or: npm run deploy:sync-job
#   IMAGE=me-west1-docker.pkg.dev/…:tag bash infra/deploy-sync-job.sh   # reuse an image
#   RUN_NOW=1 bash infra/deploy-sync-job.sh     # also run the job once (logs in to real banks)
#
# Safe to re-run: every resource is created if missing and updated otherwise.
# Requires: gcloud, logged in as a project owner (`gcloud auth login`).
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-takziv-25fd8}"
REGION="${REGION:-me-west1}"
# Cloud Scheduler isn't offered in every region; override if me-west1 is rejected.
SCHEDULER_LOCATION="${SCHEDULER_LOCATION:-$REGION}"
KEYRING="${KEYRING:-takziv}"
KEY="${KEY:-bank-credentials}"
AR_REPO="${AR_REPO:-takziv}"
JOB="${JOB:-takziv-sync-job}"
SCHEDULE_NAME="${SCHEDULE_NAME:-takziv-daily-sync}"
SCHEDULE="${SCHEDULE:-0 6 * * *}"
TIME_ZONE="${TIME_ZONE:-Asia/Jerusalem}"
# Simultaneous Chromium instances in the job (~300-500MB RAM each); sized
# together with JOB_MEMORY / JOB_CPU below.
MAX_CONCURRENT_SCRAPES="${MAX_CONCURRENT_SCRAPES:-2}"
JOB_MEMORY="${JOB_MEMORY:-2Gi}"
JOB_CPU="${JOB_CPU:-2}"
# Each scrape times out at 120s; 30 min covers ~30 due connections at 2 in parallel.
JOB_TIMEOUT="${JOB_TIMEOUT:-30m}"

SYNC_SA="takziv-sync@${PROJECT_ID}.iam.gserviceaccount.com"
SCHEDULER_SA="takziv-scheduler@${PROJECT_ID}.iam.gserviceaccount.com"
KMS_KEY="projects/${PROJECT_ID}/locations/${REGION}/keyRings/${KEYRING}/cryptoKeys/${KEY}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

step() { echo "▸ $*"; }
die() { echo "✖ $*" >&2; exit 1; }

# ── Prerequisites ──────────────────────────────────────────────────────────
command -v gcloud >/dev/null 2>&1 || die "gcloud is not installed: https://cloud.google.com/sdk/docs/install"
ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -n1)"
[[ -n "$ACCOUNT" ]] || die "gcloud is not logged in. Run: gcloud auth login"
gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1 ||
  die "Project $PROJECT_ID not found or $ACCOUNT can't access it (set PROJECT_ID=…)"
gcloud config set project "$PROJECT_ID" >/dev/null
echo "Deploying $JOB to $PROJECT_ID ($REGION) as $ACCOUNT"

gcloud iam service-accounts describe "$SYNC_SA" >/dev/null 2>&1 ||
  die "Service account $SYNC_SA is missing. Run infra/setup-kms.sh first."
gcloud kms keys describe "$KEY" --keyring "$KEYRING" --location "$REGION" >/dev/null 2>&1 ||
  die "KMS key $KMS_KEY is missing. Run infra/setup-kms.sh first."
# The job can't read any saved login without decrypt on the key.
# (Captured first: `grep -q` in a pipeline can trip pipefail via SIGPIPE.)
KEY_POLICY="$(gcloud kms keys get-iam-policy "$KEY" --keyring "$KEYRING" --location "$REGION" \
  --flatten='bindings[].members' --format='value(bindings.role,bindings.members)')"
grep -qE "cloudkms\.cryptoKey(Encrypter)?Decrypter[[:space:]]+serviceAccount:${SYNC_SA}$" <<<"$KEY_POLICY" ||
  die "$SYNC_SA has no decrypt role on $KEY. Re-run infra/setup-kms.sh (it sets the key permissions)."

step "Enabling APIs"
gcloud services enable run.googleapis.com cloudscheduler.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com

# ── Image ──────────────────────────────────────────────────────────────────
if [[ -z "${IMAGE:-}" ]]; then
  gcloud artifacts repositories describe "$AR_REPO" --location "$REGION" >/dev/null 2>&1 || {
    step "Creating Artifact Registry repository $AR_REPO"
    gcloud artifacts repositories create "$AR_REPO" --location "$REGION" --repository-format docker \
      --description "takziv container images"
  }

  TAG="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || date -u +%Y%m%d%H%M%S)"
  if [[ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]]; then
    echo "  ! Working tree has uncommitted changes; they will be included in the image."
    TAG="${TAG}-dirty-$(date -u +%Y%m%d%H%M%S)"
  fi
  IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/takziv-server:${TAG}"

  step "Building $IMAGE with Cloud Build (uploads the repo minus .gcloudignore)"
  gcloud builds submit "$REPO_ROOT" --config "$REPO_ROOT/server/cloudbuild.yaml" \
    --substitutions "_IMAGE=$IMAGE"
else
  step "Using existing image $IMAGE"
fi

# ── Cloud Run Job ──────────────────────────────────────────────────────────
# `deploy` creates the job or updates it in place. --args replaces the image's
# CMD but keeps its ENTRYPOINT (dumb-init), which reaps Chromium's child
# processes. Retries are off: a retried run would log in to banks again, and
# per-connection failures don't fail the run anyway (see syncJob.ts).
step "Deploying Cloud Run Job $JOB"
gcloud run jobs deploy "$JOB" \
  --region "$REGION" \
  --image "$IMAGE" \
  --service-account "$SYNC_SA" \
  --args "node,build/server/src/syncJob.js" \
  --tasks 1 \
  --parallelism 1 \
  --max-retries 0 \
  --task-timeout "$JOB_TIMEOUT" \
  --memory "$JOB_MEMORY" \
  --cpu "$JOB_CPU" \
  --set-env-vars "FIREBASE_PROJECT_ID=${PROJECT_ID},KMS_CREDENTIALS_KEY=${KMS_KEY},MAX_CONCURRENT_SCRAPES=${MAX_CONCURRENT_SCRAPES}"

# ── Scheduler identity: may run this job and nothing else ──────────────────
gcloud iam service-accounts describe "$SCHEDULER_SA" >/dev/null 2>&1 || {
  step "Creating service account takziv-scheduler"
  gcloud iam service-accounts create takziv-scheduler --display-name "takziv-scheduler"
}
step "Granting takziv-scheduler run access on $JOB"
gcloud run jobs add-iam-policy-binding "$JOB" --region "$REGION" \
  --member "serviceAccount:$SCHEDULER_SA" --role roles/run.invoker >/dev/null
# Cloud Scheduler's service agent mints the OAuth token for takziv-scheduler.
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
gcloud iam service-accounts add-iam-policy-binding "$SCHEDULER_SA" \
  --member "serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-cloudscheduler.iam.gserviceaccount.com" \
  --role roles/iam.serviceAccountTokenCreator >/dev/null

# ── Cloud Scheduler trigger ────────────────────────────────────────────────
RUN_URI="https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/jobs/${JOB}:run"
SCHEDULER_ARGS=(
  --location "$SCHEDULER_LOCATION"
  --schedule "$SCHEDULE"
  --time-zone "$TIME_ZONE"
  --uri "$RUN_URI"
  --http-method POST
  --oauth-service-account-email "$SCHEDULER_SA"
)
if gcloud scheduler jobs describe "$SCHEDULE_NAME" --location "$SCHEDULER_LOCATION" >/dev/null 2>&1; then
  step "Updating Cloud Scheduler trigger $SCHEDULE_NAME"
  gcloud scheduler jobs update http "$SCHEDULE_NAME" "${SCHEDULER_ARGS[@]}" >/dev/null
else
  step "Creating Cloud Scheduler trigger $SCHEDULE_NAME"
  gcloud scheduler jobs create http "$SCHEDULE_NAME" "${SCHEDULER_ARGS[@]}" \
    --description "Daily bank sync: runs Cloud Run Job $JOB" >/dev/null
fi

if [[ "${RUN_NOW:-}" == "1" ]]; then
  step "Running $JOB once now"
  gcloud run jobs execute "$JOB" --region "$REGION" --wait
fi

echo
echo "Done."
echo "  Job:       $JOB ($REGION), image $IMAGE"
echo "  Schedule:  $SCHEDULE_NAME, '$SCHEDULE' $TIME_ZONE"
echo
echo "Run it once by hand (logs in to every due bank connection):"
echo "  gcloud run jobs execute $JOB --region $REGION --wait"
echo "Or trigger the schedule:"
echo "  gcloud scheduler jobs run $SCHEDULE_NAME --location $SCHEDULER_LOCATION"
echo "Logs:"
echo "  gcloud logging read 'resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"$JOB\"' --limit 50"
