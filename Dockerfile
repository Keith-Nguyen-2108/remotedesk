# Render builds the relay from this file at the repo root.
#
# The relay's own sources live under server/ - this repo holds both the desktop
# app and the relay, and the app owns the root package.json. Keeping the
# Dockerfile here (rather than only at server/Dockerfile) is what lets Render's
# default "Dockerfile at the repository root" setup go on working unchanged
# after the app moved in alongside it.
FROM node:22-alpine AS build
WORKDIR /app
COPY server/package.json ./
RUN npm install
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY server/package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["node", "dist/main.js"]
