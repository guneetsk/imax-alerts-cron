# Stage 1: Get curl-impersonate binary from official image
FROM lwthiker/curl-impersonate:0.5.2-chrome-slim-buster AS curl-src

# Stage 2: Node.js app with curl-impersonate
FROM node:24-slim

# Copy curl-impersonate binaries
COPY --from=curl-src /usr/local/bin/curl_* /usr/local/bin/
COPY --from=curl-src /usr/local/lib/libcurl-impersonate* /usr/local/lib/
RUN ldconfig

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
CMD ["node", "index.js"]
