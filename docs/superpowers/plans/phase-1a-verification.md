# Phase 1a — Manual Smoke

Prereqs: `docker compose -f infra/docker-compose.yml up -d`; Firebase project + `apps/mobile/.env` filled.

1. Migrate + seed:
   DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable go run ./cmd/migrate
   DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable go run ./cmd/seed
2. Run API: DATABASE_URL=... FIREBASE_PROJECT_ID=kora-app go run ./cmd/api
3. Run app: cd apps/mobile && npx expo start --port 8199 --ios
4. In the sim: sign up → onboarding (goal + metrics) → Continue → dashboard shows targets.
5. ＋ Log food → search "chicken" → pick → 200g → lunch → Log it → dashboard kcal/protein rise, provenance chip shows on the entry.
6. +500ml water → water total rises. Kill and reopen app → streak = 1.
