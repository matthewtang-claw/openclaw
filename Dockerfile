FROM node:22-bookworm@sha256:cd7bcd2e7a1e6f72052feb023c7f6b722205d3fcab7bbcbd2d1bfdab10b1e935

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# ← Add your custom binaries here (as root, before WORKDIR)
# Optional: common helpers via apt (e.g., socat, jq if needed)
RUN apt-get update && apt-get install -y socat jq tmux && rm -rf /var/lib/apt/lists/*

# Gmail CLI (gogcli) - v0.9.0 Linux amd64
RUN curl -L /tmp/gogcli.tar.gz https://github.com/steipete/gogcli/releases/download/v0.9.0/gogcli_0.9.0_linux_amd64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/gog

# Add more binaries below using the same pattern
# GitHub CLI (gh) - pinned to v2.86.0 Linux amd64
RUN curl -L -f -o /tmp/gh.tar.gz https://github.com/cli/cli/releases/download/v2.86.0/gh_2.86.0_linux_amd64.tar.gz && \
    tar -xzf /tmp/gh.tar.gz -C /usr/local/bin gh_2.86.0_linux_amd64/bin/gh --strip-components=2 && \
    chmod +x /usr/local/bin/gh && \
    rm -f /tmp/gh.tar.gz

# Install Aliyun CLI v3
RUN curl -fsSL "https://aliyuncli.alicdn.com/aliyun-cli-linux-latest-amd64.tgz" -o /tmp/aliyun.tgz \
  && tar -xzf /tmp/aliyun.tgz -C /usr/local/bin \
  && rm -f /tmp/aliyun.tgz \
  && aliyun version

# Cursor Agent CLI (agent) - copy full install dir (wrapper + node + index.js)
RUN curl -fsS https://cursor.com/install | bash \
  && mkdir -p /usr/local/share \
  && cp -a /root/.local/share/cursor-agent /usr/local/share/cursor-agent \
  && CURSOR_VER="$(ls -1 /usr/local/share/cursor-agent/versions | head -n 1)" \
  && ln -sf "/usr/local/share/cursor-agent/versions/${CURSOR_VER}/cursor-agent" /usr/local/bin/agent \
  && /usr/local/bin/agent --version

RUN corepack enable

WORKDIR /app
RUN chown node:node /app

# Install Eclipse Temurin JDK 21 (Adoptium) on Debian bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg && \
mkdir -p /etc/apt/keyrings && \
curl -fsSL https://packages.adoptium.net/artifactory/api/gpg/key/public \
| gpg --dearmor -o /etc/apt/keyrings/adoptium.gpg && \
echo "deb [signed-by=/etc/apt/keyrings/adoptium.gpg] https://packages.adoptium.net/artifactory/deb bookworm main" \
> /etc/apt/sources.list.d/adoptium.list && \
apt-get update && \
apt-get install -y --no-install-recommends temurin-21-jdk && \
rm -rf /var/lib/apt/lists/*

ARG OPENCLAW_DOCKER_APT_PACKAGES=""
RUN if [ -n "$OPENCLAW_DOCKER_APT_PACKAGES" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $OPENCLAW_DOCKER_APT_PACKAGES && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fi

RUN npm i -g clawhub
RUN npm i -g vercel

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY --chown=node:node ui/package.json ./ui/package.json
COPY --chown=node:node patches ./patches
COPY --chown=node:node scripts ./scripts

USER node
RUN pnpm install --frozen-lockfile

# Optionally install Chromium and Xvfb for browser automation.
# Build with: docker build --build-arg OPENCLAW_INSTALL_BROWSER=1 ...
# Adds ~300MB but eliminates the 60-90s Playwright install on every container start.
# Must run after pnpm install so playwright-core is available in node_modules.
USER root
ARG OPENCLAW_INSTALL_BROWSER=""
RUN if [ -n "$OPENCLAW_INSTALL_BROWSER" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb && \
      mkdir -p /home/node/.cache/ms-playwright && \
      PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright \
      node /app/node_modules/playwright-core/cli.js install --with-deps chromium && \
      chown -R node:node /home/node/.cache/ms-playwright && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fi

USER node
COPY --chown=node:node . .
RUN pnpm build
# Force pnpm for UI build (Bun may fail on ARM/Synology architectures)
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

ENV NODE_ENV=production

# Security hardening: Run as non-root user
# The node:22-bookworm image includes a 'node' user (uid 1000)
# This reduces the attack surface by preventing container escape via root privileges
USER node

# Start gateway server with default config.
# Binds to loopback (127.0.0.1) by default for security.
#
# For container platforms requiring external health checks:
#   1. Set OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD env var
#   2. Override CMD: ["node","openclaw.mjs","gateway","--allow-unconfigured","--bind","lan"]
CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
