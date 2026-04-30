# District 6 Compliance Backend — Railway image.
#
# We switched off Nixpacks for this service when adding Puppeteer, because
# the bundled Chromium needs:
#   - a curated set of shared libs (libnss3, libgbm1, libcups2, etc.)
#   - a writable cache dir that persists from build → runtime
#   - the open-source Carlito font so receipts match the Calibri-styled
#     policy PDFs without checking TTFs into the repo
# A Dockerfile is reproducible offline (you can `docker build` locally)
# and side-steps Nixpacks' cache-directory layer-copy quirks.
#
# Railway: set Service → Settings → Builder = Dockerfile.
# Service Root Directory stays at /backend, so the Dockerfile path Railway
# resolves is /backend/Dockerfile and `COPY . .` picks up only backend/.

FROM node:20-slim

# Puppeteer's Chromium needs these at runtime. List taken from the upstream
# Puppeteer "troubleshooting" doc for Debian/Ubuntu-based images.
# fonts-crosextra-carlito gives us Carlito (open-source Calibri stand-in)
# without committing TTFs to the repo. fonts-liberation covers the rest of
# Chromium's default font fallbacks.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates \
       fonts-crosextra-carlito \
       fonts-liberation \
       libasound2 \
       libatk-bridge2.0-0 \
       libatk1.0-0 \
       libc6 \
       libcairo2 \
       libcups2 \
       libdbus-1-3 \
       libdrm2 \
       libexpat1 \
       libfontconfig1 \
       libgbm1 \
       libgcc-s1 \
       libglib2.0-0 \
       libgtk-3-0 \
       libnspr4 \
       libnss3 \
       libpango-1.0-0 \
       libx11-6 \
       libx11-xcb1 \
       libxcb1 \
       libxcomposite1 \
       libxcursor1 \
       libxdamage1 \
       libxext6 \
       libxfixes3 \
       libxi6 \
       libxrandr2 \
       libxrender1 \
       libxss1 \
       libxtst6 \
       lsb-release \
       wget \
       xdg-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first so the layer caches across code-only changes.
# Puppeteer's postinstall downloads Chromium to /root/.cache/puppeteer in
# this base image; the cache lives inside the final image.
COPY package*.json ./
RUN npm ci --omit=dev

# Then the source. The Railway service root is /backend, so this picks up
# server.js, routes/, lib/, migrations/, etc. — everything inside backend/.
COPY . .

# Railway sets PORT at runtime; server.js already honors it (default 3000).
EXPOSE 3000

CMD ["node", "server.js"]
