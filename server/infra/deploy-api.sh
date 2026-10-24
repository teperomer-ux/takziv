#!/usr/bin/env bash
# Deploys the API (server/src/index.ts: bank sync, saved connections, AI
# assistant) to Google Cloud:
#
#   1. builds server/Dockerfile with Cloud Build and pushes it to Artifact
#      Registry (skip with IMAGE=<existing image>) — no local Docker needed
#   2. stores the AI provider key in Secret Manager, readable only by
#      takziv-api (optional; without it the assistant reports "not configured")
#   3. creates or updates the Cloud Run service  takziv-api, running as
#      takziv-api (Firestore + KMS encrypt/decrypt)
#
# Run infra/setup-kms.sh first (once): it creates the KMS key and the
# takziv-api account this service depends on.
#
#   bash infra/deploy-api.sh                                  # from server/
#   GEMINI_API_KEY=… bash infra/deploy-api.sh                 # also store/rotate the AI key
#   AI_KEY_ENV=ANTHROPIC_API_KEY ANTHROPIC_API_KEY=… bash infra/deploy-api.sh
#   IMAGE=me-west1-docker.pkg.dev/…:tag bash infra/deploy-api.sh   # reuse an image
#
# The AI key is read from the environment only, never from a flag, so it
# doesn't land in shell history; it is piped to Secret Manager, never printed.
#
# Safe to re-run: every resource is created if missing and updated otherwise.
# Requires: gcloud, logged in as a project owner (`gcloud auth login`).
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-takziv-25fd8}"
REGION="${REGION:-me-west1}"
KEYRING="${KEYRING:-takziv}"
KEY="${KEY:-bank-credentials}"
AR_REPO="${AR_REPO:-takziv}"
SERVICE="${SERVICE:-takziv-api}"
# The app's Firebase Hosting origins; comma-separated.
ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-https://${PROJECT_ID}.web.app,https://${PROJECT_ID}.firebaseapp.com}"
# One request can hold a Chromium instance (~300-500MB RAM) for up to the
# 120s scrape timeout; MEMORY / CPU / MAX_CONCURRENT_SCRAPES are sized together.
MEMORY="${MEMORY:-2Gi}"
CPU="${CPU:-2}"
TIMEOUT="${TIMEOUT:-300}"
CONCURRENCY="${CONCURRENCY:-4}"
MAX_CONCURRENT_SCRAPES="${MAX_CONCURRENT_SCRAPES:-2}"
MIN_INSTANCES="${MIN_INSTANCES:-0}"
MAX_INSTANCES="${MAX_INSTANCES:-3}"
# Which environment variable carries the AI key, and the secret that holds it.
AI_KEY_ENV="${AI_KEY_ENV:-GEMINI_API_KEY}"
case "$AI_KEY_ENV" in
  GEMINI_API_KEY) DEFAULT_SECRET="gemini-api-key" ;;
  ANTHROPIC_API_KEY) DEFAULT_SECRET="anthropic-api-key" ;;
  *) echo "✖ AI_KEY_ENV must be GEMINI_API_KEY or ANTHROPIC_API_KEY" >&2; exit 1 ;;
esac
AI_SECRET="${AI_SECRET:-$DEFAULT_SECRET}"

API_SA="takziv-api@${PROJECT_ID}.iam.gserviceaccount.com"
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
echo "Deploying $SERVICE to $PROJECT_ID ($REGION) as $ACCOUNT"

gcloud iam service-accounts describe "$API_SA" >/dev/null 2>&1 ||
  die "Service account $API_SA is missing. Run infra/setup-kms.sh first."
gcloud kms keys describe "$KEY" --keyring "$KEYRING" --location "$REGION" >/dev/null 2>&1 ||
  die "KMS key $KMS_KEY is missing. Run infra/setup-kms.sh first."
# Saving a connection encrypts; "sync now" decrypts.
# (Captured first: `grep -q` in a pipeline can trip pipefail via SIGPIPE.)
KEY_POLICY="$(gcloud kms keys get-iam-policy "$KEY" --keyring "$KEYRING" --location "$REGION" \
  --flatten='bindings[].members' --format='value(bindings.role,bindings.members)')"
grep -qE "cloudkms\.cryptoKeyEncrypterDecrypter[[:space:]]+serviceAccount:${API_SA}$" <<<"$KEY_POLICY" ||
  die "$API_SA has no encrypt/decrypt role on $KEY. Re-run infra/setup-kms.sh (it sets the key permissions)."

step "Enabling APIs"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com

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

# ── AI provider key (Secret Manager) ───────────────────────────────────────
SECRET_FLAGS=()
NEW_KEY="${!AI_KEY_ENV:-}"
if gcloud secrets describe "$AI_SECRET" >/dev/null 2>&1; then
  if [[ -n "$NEW_KEY" ]]; then
    step "Adding a new version of secret $AI_SECRET"
    printf '%s' "$NEW_KEY" | gcloud secrets versions add "$AI_SECRET" --data-file=- >/dev/null
  fi
elif [[ -n "$NEW_KEY" ]]; then
  step "Creating secret $AI_SECRET"
  printf '%s' "$NEW_KEY" | gcloud secrets create "$AI_SECRET" --replication-policy automatic --data-file=- >/dev/null
fi
unset NEW_KEY

if gcloud secrets describe "$AI_SECRET" >/dev/null 2>&1; then
  step "Granting $SERVICE read access on secret $AI_SECRET (and nothing else)"
  gcloud secrets add-iam-policy-binding "$AI_SECRET" \
    --member "serviceAccount:$API_SA" --role roles/secretmanager.secretAccessor >/dev/null
  SECRET_FLAGS=(--update-secrets "${AI_KEY_ENV}=${AI_SECRET}:latest")
else
  echo "  ! No secret $AI_SECRET and no \$$AI_KEY_ENV given: the AI assistant will answer"
  echo "    \"not configured\" until you re-run with $AI_KEY_ENV=… set."
fi

# ── Cloud Run service ──────────────────────────────────────────────────────
# Public on purpose: the browser calls it directly, and every /api route
# checks the Firebase ID token itself (src/auth.ts). Not routed through
# Firebase Hosting, whose Cloud Run rewrites time out after 60s — shorter
# than a bank scrape. gen2 gives Chromium a full Linux environment.
# Env vars use "@" as the list delimiter (gcloud's ^@^ syntax) because
# ALLOWED_ORIGINS itself contains commas.
step "Deploying Cloud Run service $SERVICE"
gcloud run deploy "$SERVICE" \
  --region "$REGION" \
  --image "$IMAGE" \
  --service-account "$API_SA" \
  --execution-environment gen2 \
  --allow-unauthenticated \
  --memory "$MEMORY" \
  --cpu "$CPU" \
  --timeout "$TIMEOUT" \
  --concurrency "$CONCURRENCY" \
  --min-instances "$MIN_INSTANCES" \
  --max-instances "$MAX_INSTANCES" \
  --cpu-boost \
  --set-env-vars "^@^FIREBASE_PROJECT_ID=${PROJECT_ID}@KMS_CREDENTIALS_KEY=${KMS_KEY}@ALLOWED_ORIGINS=${ALLOWED_ORIGINS}@MAX_CONCURRENT_SCRAPES=${MAX_CONCURRENT_SCRAPES}${AI_PROVIDER:+@AI_PROVIDER=$AI_PROVIDER}${AI_MODEL:+@AI_MODEL=$AI_MODEL}" \
  ${SECRET_FLAGS[@]+"${SECRET_FLAGS[@]}"}  # (empty-array safe under set -u on bash 3)

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"

# Smoke test: an unauthenticated call must be refused by the app's own auth
# (401), which shows the container started and is serving /api. (/healthz
# isn't used: Cloud Run reserves some paths ending in "z".)
step "Checking $URL"
STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"ping"}]}' "$URL/api/ai/query" || true)"
[[ "$STATUS" == "401" ]] && echo "  ok: /api answers 401 without a token" ||
  echo "  ! Expected 401 from $URL/api/ai/query, got ${STATUS:-no response}. Check the logs below."

echo
echo "Done."
echo "  Service:  $SERVICE ($REGION), image $IMAGE"
echo "  URL:      $URL"
echo "  CORS:     $ALLOWED_ORIGINS"
echo
echo "Point the frontend at it (repo root), then deploy Hosting:"
echo "  echo 'VITE_API_BASE_URL=$URL' >> .env.production"
echo "  npm run build && firebase deploy --only hosting"
echo "Logs:"
echo "  gcloud logging read 'resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$SERVICE\"' --limit 50"
