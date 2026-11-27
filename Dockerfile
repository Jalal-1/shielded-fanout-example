# The hosted site: build the page, then serve it with nginx, which also passes
# chain requests to Blockfrost (see deploy/nginx.conf.template).

FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
# Dependencies first, so that editing the source does not reinstall them.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY contract/package.json contract/
COPY sdk/package.json sdk/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM nginx:1.27-alpine
# The official image fills in ${...} in /etc/nginx/templates/*.template from the
# environment when the container starts, and writes the result to conf.d/. With
# the setting below it also provides ${NGINX_LOCAL_RESOLVERS}: the DNS servers
# of wherever the container runs.
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1
COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
