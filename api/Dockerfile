FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /bin/api ./cmd/api
# migrate ships in the same image so the ArgoCD PreSync Job can run
# `go run ./cmd/migrate`'s equivalent as /usr/local/bin/migrate before deploy.
RUN CGO_ENABLED=0 GOOS=linux go build -o /bin/migrate ./cmd/migrate
# seed + ingest populate food_items, which the resolver reads to build
# candidates. Without them prod had an EMPTY food index: every AI resolve
# returned no candidates and no meal could be logged at all. Both are
# idempotent (re-running inserts 0), so the Job that runs them is safe to
# re-run on every sync.
RUN CGO_ENABLED=0 GOOS=linux go build -o /bin/seed ./cmd/seed
RUN CGO_ENABLED=0 GOOS=linux go build -o /bin/ingest ./cmd/ingest
# embed backfills food_items.embedding, the ONLY source of sub-0.70 match
# scores. Without it the resolver's embedding tier is dead: every item scores
# 0.70-0.99 via full-text, so `follow_up` is unreachable and per-item
# confidence tiers can never fire. Same omission as seed/ingest before #67.
RUN CGO_ENABLED=0 GOOS=linux go build -o /bin/embed ./cmd/embed

FROM alpine:3.19
# ca-certificates is required for outbound HTTPS — the Firebase Admin SDK
# fetches Google's public signing certs to verify ID tokens at runtime.
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 app
USER app
COPY --from=build /bin/api /usr/local/bin/api
COPY --from=build /bin/migrate /usr/local/bin/migrate
COPY --from=build /bin/seed /usr/local/bin/seed
COPY --from=build /bin/ingest /usr/local/bin/ingest
COPY --from=build /bin/embed /usr/local/bin/embed
# The AFCD/USDA source data cmd/ingest reads. Lives at api/data/food in the
# repo (deliberately NOT testdata/, which is test-only by Go convention and
# has no business in a production image). Pass the absolute paths, since the
# binary's relative defaults assume the repo layout.
COPY --from=build /src/data/food /usr/local/share/kora/food
EXPOSE 8080
ENTRYPOINT ["api"]
