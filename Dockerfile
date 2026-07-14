# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24.12.0-bookworm-slim@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,id=pdf-approval-build-npm,target=/root/.npm npm ci
COPY tsconfig.json vite.config.ts ./
COPY src ./src
RUN npm run build

FROM ${NODE_IMAGE} AS runtime-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,id=pdf-approval-runtime-npm,target=/root/.npm npm ci --omit=dev

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    PDF_APPROVAL_RUNTIME_MODE=platform
WORKDIR /app
RUN groupadd --gid 10001 pdfapproval \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin pdfapproval \
    && mkdir -p /var/lib/pdf-approval/webdav-staging \
    && chown -R 10001:10001 /var/lib/pdf-approval
COPY --from=runtime-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist/client ./dist/client
COPY package.json package-lock.json ./
COPY migrations ./migrations
COPY src ./src
COPY deploy/container-entrypoint.sh deploy/healthcheck.mjs ./deploy/
RUN chmod 0555 /app/deploy/container-entrypoint.sh \
    && chmod 0444 /app/deploy/healthcheck.mjs
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/app/deploy/container-entrypoint.sh"]
CMD ["web"]
