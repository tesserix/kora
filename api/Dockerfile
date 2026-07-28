FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /bin/api ./cmd/api
# migrate ships in the same image so the ArgoCD PreSync Job can run
# `go run ./cmd/migrate`'s equivalent as /usr/local/bin/migrate before deploy.
RUN CGO_ENABLED=0 GOOS=linux go build -o /bin/migrate ./cmd/migrate

FROM alpine:3.19
# ca-certificates is required for outbound HTTPS — the Firebase Admin SDK
# fetches Google's public signing certs to verify ID tokens at runtime.
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 app
USER app
COPY --from=build /bin/api /usr/local/bin/api
COPY --from=build /bin/migrate /usr/local/bin/migrate
EXPOSE 8080
ENTRYPOINT ["api"]
