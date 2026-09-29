# Playwright image ships Chromium + all Linux deps. Keep this tag equal to the
# "playwright" version in package.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb x11vnc novnc websockify fluxbox gosu python3 make g++ wget gnupg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Google Chrome itself, not a Chromium build: it is what the automation drives and what a desktop
# sign-in opens, so sites see an ordinary browser and the profile never changes hands between versions.
RUN wget -qO- https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends google-chrome-stable \
 && rm -rf /var/lib/apt/lists/*

# Chrome must not run as root: root is maximum blast radius and cannot start the
# user-namespace sandbox that keeps one workspace's pages away from another's cookies.
# The Playwright image ships the unprivileged `pwuser`; the app is built and run as it.
# Deployments pair this with docker/seccomp_profile.json so the sandbox's userns clone
# is allowed through seccomp.
RUN mkdir -p /data /tmp/.X11-unix \
 && chmod 1777 /tmp/.X11-unix \
 && chown pwuser:pwuser /data

WORKDIR /app
RUN chown pwuser:pwuser /app
USER pwuser
COPY --chown=pwuser:pwuser package.json package-lock.json ./
RUN npm ci

COPY --chown=pwuser:pwuser tsconfig.json ./
COPY --chown=pwuser:pwuser packages ./packages
COPY --chown=pwuser:pwuser apps ./apps
COPY --chown=pwuser:pwuser src ./src
COPY --chown=pwuser:pwuser public ./public
COPY --chown=pwuser:pwuser docker ./docker
RUN npm run build && npm prune --omit=dev

# Root again only for the entrypoint: start.sh hands the runtime volume (mounted root-owned
# on most platforms) to pwuser, then immediately re-runs itself as pwuser through gosu.
USER root

ENV NODE_ENV=production \
    DATA_DIR=/data \
    DISPLAY=:99 \
    HEADLESS=false \
    BROWSER_CHANNEL=chrome \
    PORT=8080 \
    SCREEN_GEOMETRY=1280x800x24

EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-8080}/healthz" >/dev/null 2>&1 || exit 1
CMD ["bash", "docker/start.sh"]
