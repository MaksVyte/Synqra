# syntax=docker/dockerfile:1
# Multi-stage build: compile in a full Rust image, run in a slim Debian image.

FROM rust:1-slim AS builder

WORKDIR /app

# Cache dependency crates before copying source.
COPY Cargo.toml Cargo.lock ./
COPY src ./src

# The app is Linux-native on the LXC host; the container build picks up the
# default stable toolchain (the Windows gnullvm override is excluded via
# .dockerignore so it does not leak into the Linux build).
RUN cargo build --release

# ---------------------------------------------------------------------------

FROM debian:bookworm-slim AS runtime

# curl is needed for the container healthcheck.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Run as an unprivileged user.
RUN groupadd --system obsidian \
    && useradd --system --gid obsidian --create-home obsidian \
    && mkdir -p /data \
    && chown obsidian:obsidian /data

COPY --from=builder /app/target/release/synqra-server /usr/local/bin/synqra-server

USER obsidian

EXPOSE 5612

ENV HOST=0.0.0.0
ENV PORT=5612
ENV DATA_DIR=/data
ENV SERVER_PASSWORD=changethispassword
ENV ADMIN_PASSWORD=adminchangethispassword

# Room vaults are persisted here (mount a named volume or bind mount).
VOLUME ["/data"]

CMD ["synqra-server"]
