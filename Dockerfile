FROM node:latest

RUN mkdir /XChainSDK/
COPY ./package.json /XChainSDK/package.json
WORKDIR /XChainSDK
RUN npm install

COPY ./src /XChainSDK/src
COPY ./.en[v] /XChainSDK/.env

CMD ["npm", "run", "api"]