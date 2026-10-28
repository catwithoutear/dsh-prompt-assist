# syntax=docker/dockerfile:1.7
#
# Two stages:
#   1. build   - installs the repository, runs the package's own prepack
#                (build + check + tests) and produces the publishable tarball.
#   2. runtime - installs one exact @deepseek-ai/dsh host, the harness's
#                Playwright test runner, and a Chromium build; then runs the
#                real web profile against the packed tarball.
#
# The DSH version is deliberately a build argument: verification/dsh-versions.json
# is the support matrix, and CI builds the same Dockerfile once per entry.
# DSH_VERSION is declared late so the expensive apt, Playwright, and browser
# layers are shared by every matrix cell.

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV npm_config_registry=${NPM_REGISTRY} \
    npm_config_replace_registry_host=always
WORKDIR /repo
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN mkdir -p /out && npm pack --pack-destination /out

FROM ${NODE_IMAGE} AS runtime
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG PLAYWRIGHT_DOWNLOAD_HOST=

ENV DEBIAN_FRONTEND=noninteractive \
    npm_config_registry=${NPM_REGISTRY} \
    npm_config_replace_registry_host=always \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_DOWNLOAD_HOST=${PLAYWRIGHT_DOWNLOAD_HOST} \
    PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=120000

# Debian mirrors occasionally stall on large packages; retry and time out
# instead of hanging the whole matrix cell.
RUN printf 'Acquire::Retries "5";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n' \
      > /etc/apt/apt.conf.d/80retries

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates curl fonts-noto-cjk xdg-user-dirs \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@10 \
  && pnpm config set registry "${NPM_REGISTRY}" --global

WORKDIR /verify

# Harness-only dependencies live in verification/package.json; the plugin
# itself is installed from the tarball, exactly like a user install.
COPY verification/package.json verification/package-lock.json ./
RUN npm ci --no-audit --no-fund \
  && npx playwright install --with-deps chromium

# Everything above is shared by the matrix; only the DSH host changes per cell.
ARG DSH_VERSION
RUN test -n "${DSH_VERSION}" || (echo "DSH_VERSION build arg is required" >&2; exit 1)
RUN npm install -g "@deepseek-ai/dsh@${DSH_VERSION}" \
  && npm cache clean --force

COPY verification/ ./
COPY --from=build /out/*.tgz /verify/plugin.tgz
ENV DSH_VERSION=${DSH_VERSION}

CMD ["bash", "/verify/entrypoint.sh"]
