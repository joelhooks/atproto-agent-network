FROM docker.io/cloudflare/sandbox:0.7.0-python

# Python deps (numpy, pandas, matplotlib already in base)
RUN python3 -m pip install --no-cache-dir pydantic aiohttp
RUN [ -x /usr/local/bin/python ] || ln -s "$(command -v python3)" /usr/local/bin/python

# Node.js tools for coding environments
RUN npm install -g typescript tsx

# Git config
RUN git config --global user.name "agent-sandbox" && git config --global user.email "sandbox@agent-network"

# Turn processor scripts (all environment types)
COPY scripts/ /workspace/scripts/

# Skills files
COPY skills/ /workspace/skills/
