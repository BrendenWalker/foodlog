# syntax=docker/dockerfile:1

FROM golang:1.26-alpine AS build
WORKDIR /src
RUN apk add --no-cache ca-certificates
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/foodlog-sync ./cmd/foodlog-sync

FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata \
  && adduser -D -H -u 10001 foodlog
USER foodlog
COPY --from=build /out/foodlog-sync /usr/local/bin/foodlog-sync
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/usr/local/bin/foodlog-sync"]
