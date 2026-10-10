package com.paysense.integration

import org.junit.jupiter.api.Test
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class AnomalyAndIncidentIT : IntegrationTestBase() {
    private val anomaly =
        """
        {"anomalies":[{"metric":"FAILURE_RATE","dimension":"MOCK_PROCESSOR","windowStart":"2026-01-01T10:00:00Z","windowEnd":"2026-01-01T11:00:00Z",
         "observed":0.6,"baseline":0.05,"threshold":0.2,"score":9.1,"direction":"HIGH","severity":"HIGH","method":"MAD","sampleSize":30,"details":{"note":"test"}}]}
        """.trimIndent()

    private fun postAnomalies(
        json: String = anomaly,
        header: Pair<String, String>? = "X-Service-Token" to "dev-service-token",
    ) = mvc
        .perform(
            post("/api/v1/internal/anomalies").contentType(MediaType.APPLICATION_JSON).content(json).also { b ->
                header?.let { b.header(it.first, it.second) }
            },
        ).andReturn()

    @Test
    fun `only the AI service credential may persist anomalies`() {
        assertEquals(401, postAnomalies(header = null).response.status)
        assertEquals(401, postAnomalies(header = "X-Service-Token" to "wrong").response.status)
        assertEquals(
            403,
            mvc
                .perform(
                    post("/api/v1/internal/anomalies").auth(admin).contentType(MediaType.APPLICATION_JSON).content(anomaly),
                ).andReturn()
                .response.status,
            "even an ADMIN user token is not the service identity",
        )
        assertEquals(0, count("SELECT COUNT(*) FROM anomaly_events"))
        assertEquals(200, postAnomalies().response.status)
    }

    @Test
    fun `persisting is idempotent per metric, dimension and window`() {
        val first = json(postAnomalies())
        val second = json(postAnomalies())
        assertEquals(true, first[0]["created"].asBoolean())
        assertEquals(false, second[0]["created"].asBoolean())
        assertEquals(first[0]["id"].asText(), second[0]["id"].asText())
        assertEquals(1, count("SELECT COUNT(*) FROM anomaly_events"))
        assertEquals(1, count("SELECT COUNT(*) FROM incidents"), "re-posting must not open a second incident")
    }

    @Test
    fun `a high-severity anomaly opens a correlated incident with the affected failed payments attached`() {
        val failing = (1..3).map { newPaymentId(paymentBody(description = "[sim:insufficient_funds]")) }
        failing.forEach { operate(it, "authorize") }
        val now = java.time.Instant.now()
        val body =
            anomaly
                .replace(
                    "2026-01-01T10:00:00Z",
                    now.minusSeconds(3600).toString(),
                ).replace("2026-01-01T11:00:00Z", now.plusSeconds(60).toString())
        postAnomalies(body)
        val incident = json(getJson("/api/v1/incidents"))["items"][0]
        assertEquals("ANOMALY", incident["source"].asText())
        assertEquals("HIGH", incident["severity"].asText())
        assertEquals(listOf("MOCK_PROCESSOR"), incident["components"].map { it.asText() })
        val detail = json(getJson("/api/v1/incidents/${incident["id"].asText()}"))
        assertEquals(3, detail["payments"].size())
        assertEquals(1, detail["anomalies"].size())
        val kinds = detail["timeline"].map { it["kind"].asText() }.toSet()
        assertTrue(kinds.containsAll(setOf("INCIDENT", "ANOMALY", "PAYMENT_EVENT")), kinds.toString())
        assertEquals(
            detail["timeline"].map {
                it["at"].asText()
            },
            detail["timeline"].map { it["at"].asText() }.sorted(),
            "timeline is chronological",
        )
    }

    @Test
    fun `low severity anomalies are recorded but do not open incidents`() {
        postAnomalies(anomaly.replace("\"severity\":\"HIGH\"", "\"severity\":\"LOW\""))
        assertEquals(1, count("SELECT COUNT(*) FROM anomaly_events"))
        assertEquals(0, count("SELECT COUNT(*) FROM incidents"))
        assertEquals(1, json(getJson("/api/v1/anomalies"))["totalItems"].asInt())
    }

    @Test
    fun `invalid anomaly payloads are rejected`() {
        assertEquals(400, postAnomalies(anomaly.replace("\"direction\":\"HIGH\"", "\"direction\":\"SIDEWAYS\"")).response.status)
    }

    @Test
    fun `incidents can be created, listed, resolved, and filtered`() {
        val id =
            json(
                mvc
                    .perform(
                        post(
                            "/api/v1/incidents",
                        ).auth(investigator).contentType(MediaType.APPLICATION_JSON).content("""{"title":"Manual","severity":"MEDIUM"}"""),
                    ).andReturn(),
            )["id"].asText()
        assertEquals(
            403,
            mvc
                .perform(
                    post("/api/v1/incidents").auth(viewer).contentType(MediaType.APPLICATION_JSON).content("""{"title":"Nope"}"""),
                ).andReturn()
                .response.status,
        )
        assertEquals(
            400,
            mvc
                .perform(
                    post(
                        "/api/v1/incidents",
                    ).auth(investigator).contentType(MediaType.APPLICATION_JSON).content("""{"title":"Bad","severity":"CATASTROPHIC"}"""),
                ).andReturn()
                .response.status,
        )
        assertEquals(1, json(getJson("/api/v1/incidents?status=OPEN"))["totalItems"].asInt())
        assertEquals("RESOLVED", json(mvc.perform(post("/api/v1/incidents/$id/resolve").auth(investigator)).andReturn())["status"].asText())
        assertEquals(
            409,
            mvc
                .perform(post("/api/v1/incidents/$id/resolve").auth(investigator))
                .andReturn()
                .response.status,
        )
        assertEquals(0, json(getJson("/api/v1/incidents?status=OPEN"))["totalItems"].asInt())
        assertEquals(1, json(getJson("/api/v1/incidents?status=RESOLVED"))["totalItems"].asInt())
        assertEquals(
            404,
            mvc
                .perform(get("/api/v1/incidents/${java.util.UUID.randomUUID()}").auth(viewer))
                .andReturn()
                .response.status,
        )
    }

    @Test
    fun `runbook retrieval returns versioned documents with source references`() {
        val hits = json(getJson("/api/v1/runbooks/search?q=timeout uncertain"))
        assertTrue(hits.size() >= 1)
        assertEquals("rb-processor-timeouts", hits[0]["docKey"].asText())
        assertEquals(1, hits[0]["version"].asInt())
        assertEquals("RUNBOOK", hits[0]["docType"].asText())
        assertTrue(hits[0]["snippet"].asText().isNotBlank())
        assertTrue(
            json(getJson("/api/v1/runbooks/search?q=duplicate settlement&type=INCIDENT_REPORT"))[0]["docKey"].asText() == "ir-2025-002",
        )
        assertEquals(400, getJson("/api/v1/runbooks/search?q=").response.status)
        assertEquals(404, getJson("/api/v1/runbooks/does-not-exist").response.status)
        assertTrue(json(getJson("/api/v1/runbooks/rb-dead-letter-events"))["body"].asText().contains("Replay"))
    }
}
