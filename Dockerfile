# Drama Downloader — Docker image with ffmpeg (needed for Combine + Teal & Orange grade)
# Render detects this file automatically when you deploy from a Git repo.
FROM node:20-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
