package com.paysense.runbooks

import com.paysense.common.NotFoundException
import com.paysense.common.PaySenseProperties
import com.paysense.common.ValidationException
import io.swagger.v3.oas.annotations.tags.Tag
import org.slf4j.LoggerFactory
import org.springframework.boot.ApplicationArguments
import org.springframework.boot.ApplicationRunner
import org.springframework.core.io.support.PathMatchingResourcePatternResolver
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Component
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import java.sql.Timestamp
import java.time.Clock
import java.util.UUID

data class RunbookHit(
    val docKey: String,
    val version: Int,
    val docType: String,
    val title: String,
    val tags: List<String>,
    val snippet: String,
    val rank: Double,
)

data class RunbookDocument(
    val docKey: String,
    val version: Int,
    val docType: String,
    val title: String,
    val tags: List<String>,
    val body: String,
)

/** Loads the curated, synthetic runbooks and historical incident reports shipped with the application. */
@Component
class RunbookLoader(
    private val jdbc: JdbcClient,
    private val props: PaySenseProperties,
    private val clock: Clock,
) : ApplicationRunner {
    private val log = LoggerFactory.getLogger(javaClass)

    override fun run(args: ApplicationArguments) {
        if (!props.runbooks.loadOnStart) return
        val resources = PathMatchingResourcePatternResolver().getResources("classpath:runbooks/*.md")
        var loaded = 0
        for (r in resources) {
            val text = r.inputStream.bufferedReader().readText()
            val (meta, body) = parse(text, r.filename ?: "?")
            val inserted =
                jdbc
                    .sql(
                        """
                INSERT INTO runbook_documents (id, doc_key, version, doc_type, title, tags, body, created_at)
                VALUES (:id, :key, :ver, :type, :title, CAST(:tags AS text[]), :body, :now) ON CONFLICT (doc_key, version) DO NOTHING
                """,
                    ).param(
                        "id",
                        UUID.randomUUID(),
                    ).param("key", meta.getValue("id"))
                    .param("ver", meta.getValue("version").toInt())
                    .param("type", meta.getValue("type"))
                    .param("title", meta.getValue("title"))
                    .param(
                        "tags",
                        "{" + meta.getValue("tags").split(",").joinToString(",") { "\"${it.trim()}\"" } + "}",
                    ).param("body", body)
                    .param("now", Timestamp.from(clock.instant()))
                    .update()
            loaded += inserted
        }
        log.info("Runbook documents available: {} files, {} newly loaded", resources.size, loaded)
    }

    private fun parse(
        text: String,
        name: String,
    ): Pair<Map<String, String>, String> {
        require(text.startsWith("---")) { "$name must start with front matter" }
        val end = text.indexOf("\n---", 3)
        require(end > 0) { "$name has unterminated front matter" }
        val meta =
            text.substring(3, end).trim().lines().filter { ":" in it }.associate { line ->
                line.substringBefore(":").trim() to
                    line.substringAfter(":").trim()
            }
        listOf("id", "title", "version", "type", "tags").forEach { require(it in meta) { "$name is missing '$it'" } }
        return meta to text.substring(end + 4).trim()
    }
}

@RestController
@RequestMapping("/api/v1/runbooks")
@Tag(name = "Runbooks")
class RunbookController(
    private val jdbc: JdbcClient,
) {
    /** Keyword/full-text search (PostgreSQL websearch syntax). Returns snippets with stable source references. */
    @GetMapping("/search")
    fun search(
        @RequestParam q: String,
        @RequestParam(required = false) type: String?,
        @RequestParam(defaultValue = "5") limit: Int,
    ): List<RunbookHit> {
        if (q.isBlank() || q.length > 200) throw ValidationException("q must be 1-200 characters")
        if (type != null &&
            type !in setOf("RUNBOOK", "INCIDENT_REPORT")
        ) {
            throw ValidationException("type must be RUNBOOK or INCIDENT_REPORT")
        }
        return jdbc
            .sql(
                """
            SELECT doc_key, version, doc_type, title, tags,
                   ts_headline('english', body, websearch_to_tsquery('english', :q), 'MaxFragments=2, MaxWords=40, MinWords=15, StartSel=«, StopSel=»') AS snippet,
                   ts_rank(search, websearch_to_tsquery('english', :q)) AS rank
              FROM runbook_documents
             WHERE search @@ websearch_to_tsquery('english', :q) AND (CAST(:type AS text) IS NULL OR doc_type = :type)
               AND version = (SELECT MAX(version) FROM runbook_documents d2 WHERE d2.doc_key = runbook_documents.doc_key)
             ORDER BY rank DESC, doc_key LIMIT :limit
            """,
            ).param("q", q)
            .param("type", type)
            .param("limit", limit.coerceIn(1, 10))
            .query { rs, _ ->
                RunbookHit(
                    rs.getString(
                        "doc_key",
                    ),
                    rs.getInt("version"),
                    rs.getString("doc_type"),
                    rs.getString("title"),
                    (rs.getArray("tags").array as Array<*>).map {
                        it.toString()
                    },
                    rs.getString("snippet"),
                    rs.getDouble("rank"),
                )
            }.list()
    }

    @GetMapping("/{docKey}")
    fun get(
        @PathVariable docKey: String,
    ): RunbookDocument =
        jdbc
            .sql(
                "SELECT * FROM runbook_documents WHERE doc_key = :k ORDER BY version DESC LIMIT 1",
            ).param("k", docKey)
            .query { rs, _ ->
                RunbookDocument(
                    rs.getString(
                        "doc_key",
                    ),
                    rs.getInt("version"),
                    rs.getString("doc_type"),
                    rs.getString("title"),
                    (rs.getArray("tags").array as Array<*>).map {
                        it.toString()
                    },
                    rs.getString("body"),
                )
            }.optional()
            .orElseThrow { NotFoundException("Runbook", docKey) }
}
