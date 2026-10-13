# syntax=docker/dockerfile:1
FROM gradle:8.14.3-jdk21 AS build
WORKDIR /src
COPY backend/gradle* backend/settings.gradle.kts backend/build.gradle.kts ./
COPY backend/gradle ./gradle
RUN gradle --no-daemon dependencies > /dev/null 2>&1 || true   # warm the dependency cache layer
COPY backend/src ./src
RUN gradle --no-daemon bootJar -x test

FROM eclipse-temurin:21-jre
RUN groupadd --system app && useradd --system --gid app --home /app app
WORKDIR /app
COPY --from=build /src/build/libs/paysense-backend.jar app.jar
USER app
EXPOSE 8080
# No secrets are baked into the image: everything comes from environment variables at runtime.
ENV JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75 -XX:+ExitOnOutOfMemoryError"
HEALTHCHECK --interval=15s --timeout=3s --start-period=40s --retries=5 \
  CMD curl -fsS http://localhost:8080/actuator/health/liveness || exit 1
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
