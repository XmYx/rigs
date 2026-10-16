# A throwaway Ubuntu 24.04 mesh node for local multi-machine testing:
#   docker build -f test/docker/Dockerfile -t rigs-ubuntu .
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git tmux openssh-client procps zsh \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash dev
USER dev
WORKDIR /home/dev/rigs
COPY --chown=dev package.json package-lock.json ./
COPY --chown=dev scripts ./scripts
RUN npm ci --no-audit --no-fund
COPY --chown=dev . .
RUN npm run build
ENV RIGS_BIND=0.0.0.0 RIGS_NAME=ubuntu-box
CMD ["node", "bin/rigs.js", "start"]
