FROM node:latest

RUN mkdir /XChainSDK/
COPY ./package.json /XChainSDK/package.json
COPY ./package-lock.json /XChainSDK/package-lock.json
WORKDIR /XChainSDK
RUN npm ci

COPY ./src /XChainSDK/src
COPY ./docs /XChainSDK/docs
# No .env is baked in: configuration reaches the container as environment
# (xchain-node at `docker run`, docker-compose.yml via env_file). An optional
# `COPY ./.en[v]` glob here builds only under BuildKit.

CMD ["npm", "run", "api"]