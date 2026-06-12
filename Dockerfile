FROM node:latest

RUN mkdir /XChainSDK/
COPY ./package.json /XChainSDK/package.json
COPY ./package-lock.json /XChainSDK/package-lock.json
WORKDIR /XChainSDK
RUN npm ci

COPY ./src /XChainSDK/src
COPY ./docs /XChainSDK/docs
COPY ./.en[v] /XChainSDK/.env

CMD ["npm", "run", "api"]