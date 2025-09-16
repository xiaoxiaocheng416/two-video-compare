#!/bin/bash

# Download yt-dlp if not exists
if [ ! -f "./yt-dlp" ]; then
  echo "Downloading yt-dlp..."
  curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o ./yt-dlp
  chmod +x ./yt-dlp
  echo "yt-dlp downloaded successfully"
fi

# Set the path
export YT_DLP_PATH="$(pwd)/yt-dlp"
echo "Using yt-dlp at: $YT_DLP_PATH"

# Start the service
exec pnpm tsx two-video-compare.ts