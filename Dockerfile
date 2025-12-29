FROM node:20-alpine

WORKDIR /app

COPY submit.js .

CMD ["node", "submit.js"]