FROM node:24-bookworm-slim
WORKDIR /app
COPY apps/mcp-server/package*.json apps/mcp-server/
RUN npm --prefix apps/mcp-server ci --omit=dev --ignore-scripts && npm cache clean --force
COPY apps/mcp-server/server.mjs apps/mcp-server/bridge-daemon.mjs apps/mcp-server/
COPY apps/mcp-server/lib/ apps/mcp-server/lib/
COPY apps/planner-proxy/server.mjs apps/planner-proxy/
COPY apps/planner-proxy/lib/ apps/planner-proxy/lib/
COPY packages/shared/plan-schema.js packages/shared/package.json packages/shared/
COPY apps/demo-survey/index.html apps/demo-survey/index.html
COPY docker/start.mjs docker/start.mjs
# ZIP extraction and host umask can leave copied sources readable only by root.
# These are public application files; private runtime configuration is excluded
# from the build context and mounted separately under /run/secrets.
RUN chmod -R a+rX /app && mkdir -p /home/node/.seeyable && chown node:node /home/node/.seeyable && chmod 700 /home/node/.seeyable
# Launcher reads the private mounted configuration, then immediately drops to node.
CMD ["node", "docker/start.mjs"]
