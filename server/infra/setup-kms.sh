#!/usr/bin/env bash
# One-time GCP setup for encrypted bank-credential storage.
#
# Creates a KMS key ring + key in Tel Aviv (me-west1) and two service
# accounts with split permissions:
#   takziv-api   can only ENCRYPT  (saves credentials the user submits)
#   takziv-sync  can only DECRYPT  (the scheduled job that logs in to banks)
# so a compromise of the public API cannot read any stored password.
#
# Safe to re-run: existing resources are left as they are.
# Requires: gcloud, logged in as a project owner (`gcloud auth login`).
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-takziv-25fd8}"
REGION="${REGION:-me-west1}"
KEYRING="${KEYRING:-takziv}"
KEY="${KEY:-bank-credentials}"
API_SA="takziv-api@${PROJECT_ID}.iam.gserviceaccount.com"
SYNC_SA="takziv-sync@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud config set project "$PROJECT_ID" >/dev/null

echo "▸ Enabling APIs"
gcloud services enable cloudkms.googleapis.com run.googleapis.com cloudscheduler.googleapis.com \
  artifactregistry.googleapis.com firestore.googleapis.com

echo "▸ Key ring and key"
gcloud kms keyrings describe "$KEYRING" --location "$REGION" >/dev/null 2>&1 ||
  gcloud kms keyrings create "$KEYRING" --location "$REGION"
# Rotation only affects new encryptions; old versions stay enabled for decrypt.
gcloud kms keys describe "$KEY" --keyring "$KEYRING" --location "$REGION" >/dev/null 2>&1 ||
  gcloud kms keys create "$KEY" --keyring "$KEYRING" --location "$REGION" \
    --purpose encryption --protection-level software \
    --rotation-period 90d --next-rotation-time "$(date -u -d '+90 days' +%Y-%m-%dT%H:%M:%SZ)"

echo "▸ Service accounts"
for sa in takziv-api takziv-sync; do
  gcloud iam service-accounts describe "${sa}@${PROJECT_ID}.iam.gserviceaccount.com" >/dev/null 2>&1 ||
    gcloud iam service-accounts create "$sa" --display-name "$sa"
done

echo "▸ Project roles (Firestore for both; token verification for the API)"
for sa in "$API_SA" "$SYNC_SA"; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$sa" \
    --role roles/datastore.user --condition None >/dev/null
done
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$API_SA" \
  --role roles/firebaseauth.viewer --condition None >/dev/null

echo "▸ Key-level roles (encrypt vs. decrypt split)"
gcloud kms keys add-iam-policy-binding "$KEY" --keyring "$KEYRING" --location "$REGION" \
  --member "serviceAccount:$API_SA" --role roles/cloudkms.cryptoKeyEncrypter >/dev/null
gcloud kms keys add-iam-policy-binding "$KEY" --keyring "$KEYRING" --location "$REGION" \
  --member "serviceAccount:$SYNC_SA" --role roles/cloudkms.cryptoKeyDecrypter >/dev/null

echo
echo "Done. Set this on both Cloud Run services/jobs:"
echo "  KMS_CREDENTIALS_KEY=projects/${PROJECT_ID}/locations/${REGION}/keyRings/${KEYRING}/cryptoKeys/${KEY}"
echo
echo "Check that nobody else holds decrypt on the key:"
echo "  gcloud kms keys get-iam-policy $KEY --keyring $KEYRING --location $REGION"
