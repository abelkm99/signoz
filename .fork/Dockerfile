# Upstream SigNoz image with only the web UI replaced by this fork's build.
# The backend binary is untouched, so SIGNOZ_VERSION must be the release the
# fork is based on (.fork/base).
#
#   .fork/build-frontend.sh
#   docker buildx build --platform linux/arm64 -f .fork/Dockerfile \
#     --build-arg SIGNOZ_VERSION=$(cat .fork/base) -t <image>:<tag> .
ARG SIGNOZ_VERSION
FROM signoz/signoz:${SIGNOZ_VERSION}
RUN rm -rf /etc/signoz/web
COPY frontend/build/ /etc/signoz/web/
