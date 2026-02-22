FROM node:18-slim

# Install FFmpeg for audio transcoding (E-AC3/DDP → AAC)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --production

# Copy application code
COPY . .

# Create required directories
RUN mkdir -p data uploads/videos uploads/chunks uploads/thumbnails

# Railway sets PORT env variable
EXPOSE 3000

CMD ["node", "server.js"]
