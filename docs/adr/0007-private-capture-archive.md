# Private meal-photo archive and capture interaction

## Decision

Meal capture displays the selected local image in the conversation and disables competing inputs during analysis. Cancel and Close remain available. The API normalizes accepted meal images to JPEG (removing EXIF/GPS), stores them in a private GCS bucket, and persists a capture manifest and the structured analysis in Postgres. The capture ID equals the resolution ID, connecting predictions with subsequent diary confirmations and corrections. No automatic model-training export is introduced.

Terraform owns `kora-prod-captures-in` in `asia-south1`, public-access prevention, uniform bucket access, CMEK, API workload IAM, and transition from Standard to Archive at 90 days. No final age-based deletion is configured: the product owner explicitly selected archival retention without a final expiry. Object versioning and soft deletion are disabled for this bucket; account deletion must not leave recoverable image copies in it. Archive has a 365-day minimum billable duration and retrieval charges; privacy deletion still takes priority.

## Capacity and reliability

Planning assumptions, not measured traffic: 10,000 uploads/day, 0.5 MB normalized average, 8 MB request ceiling, approximately 1.2 requests/s at a 10x peak. Ninety days use about 450 GB Standard; total retained images are approximately 1.8 TB at 12 months and 5.4 TB at 36 months. At 3 KB/manifest, metadata adds approximately 11 GB/year. Reads are rare compared with writes. Budget roughly $9–14/month for the hot working set and $2–4/month for the first year's archived bytes, excluding operations, retrieval, network, database and early-deletion charges; validate against actual Mumbai billing.

Target availability is 99.9% and normal photo analysis p99 <30s; measure before claiming either. Storage adds a bounded 5s pre-analysis step. When storage is unavailable, configured production capture returns a retryable 503 before spending on a model call; it does not silently promise an archive that was not written. Existing deployments without the archive configured retain their current behavior during the additive rollout.

## Consistency and deletion

Create the manifest before writing its immutable object. On account deletion, a database trigger atomically enqueues the object key before cascading away the manifest and analysis. A bounded, idempotent worker deletes queued objects after a 10-minute grace period, then acknowledges the queue row. The grace exceeds the upload deadline and prevents an in-flight upload recreating an object after the deletion worker runs. Duplicate worker execution is harmless; missing objects count as deleted. Failed deletes stay queued for retry and emit operational errors. No network calls occur inside a database transaction.

Analysis completion updates only the owning user's capture. Payloads, image bytes, signed URLs and provider error bodies are never logged. The private bucket has no public URLs or client credentials. The image and metadata belong to the authenticated principal. Account export includes manifest metadata; database backups retain their existing bounded recovery retention and must not be used to resurrect deleted accounts.

## Rollout and rollback

Apply additive storage/IAM, migrate the database, then configure the API archive and deploy the API/mobile release. Verify private access, normalized image persistence, analysis linkage, deletion retry and lifecycle configuration. Code rollback leaves the new tables/bucket intact; retained photos are not deleted as a rollback action. The migration down path refuses while manifests or deletion jobs remain, avoiding orphaned private images. A public avatar bucket and storing binary images in Postgres were rejected because they respectively violate privacy and inflate database/backup costs.
