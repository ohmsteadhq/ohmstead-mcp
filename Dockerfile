# Runs the published npm package; the source of truth is https://www.npmjs.com/package/ohmstead
FROM node:22-alpine
ARG OHMSTEAD_VERSION=0.1.0
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
RUN npm install -g ohmstead@${OHMSTEAD_VERSION}
ENTRYPOINT ["ohmstead"]
