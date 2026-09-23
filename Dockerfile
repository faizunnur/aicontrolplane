# Playwright image ships Chromium + all Linux deps. Keep this tag equal to the
# "playwright" version in package.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb x11vnc novnc websockify fluxbox python3 make g++ wget gnupg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Google Chrome itself, not a Chromium build: it is what the automation drives and what a desktop
# sign-in opens, so sites see an ordinary browser and the profile never changes hands between versions.
RUN wget -qO- https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends google-chrome-stable \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY docker ./docker
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production \
    DATA_DIR=/data \
    DISPLAY=:99 \
    HEADLESS=false \
    BROWSER_CHANNEL=chrome \
    PORT=8080 \
    SCREEN_GEOMETRY=1280x800x24

EXPOSE 8080
CMD ["bash", "docker/start.sh"]
