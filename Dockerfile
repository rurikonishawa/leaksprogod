FROM node:18-slim

# Install FFmpeg for audio transcoding (E-AC3/DDP → AAC)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Railway sets PORT env variable
EXPOSE 3000

CMD ["node", "server.js"]
