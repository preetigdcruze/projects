package com.paysense.common

import org.springframework.data.domain.Page
import org.springframework.data.domain.PageRequest
import org.springframework.data.domain.Sort
import java.time.Duration
import java.time.Instant

data class PageResponse<T>(
    val items: List<T>,
    val page: Int,
    val size: Int,
    val totalItems: Long,
    val totalPages: Int,
) {
    companion object {
        fun <T, R> of(
            page: Page<T>,
            mapper: (T) -> R,
        ) = PageResponse(page.content.map(mapper), page.number, page.size, page.totalElements, page.totalPages)

        fun <T> of(
            items: List<T>,
            page: Int,
            size: Int,
            total: Long,
        ) = PageResponse(items, page, size, total, if (size == 0) 0 else ((total + size - 1) / size).toInt())
    }
}

object Paging {
    const val MAX_PAGE_SIZE = 100

    fun validate(
        page: Int,
        size: Int,
    ) {
        if (page < 0) throw ValidationException("page must be >= 0")
        if (size < 1 || size > MAX_PAGE_SIZE) throw ValidationException("size must be between 1 and $MAX_PAGE_SIZE")
    }

    /** Parses `field,asc|desc`, accepting only allow-listed fields so clients cannot sort on arbitrary columns. */
    fun pageRequest(
        page: Int,
        size: Int,
        sort: String?,
        allowed: Map<String, String>,
        default: Sort,
    ): PageRequest {
        validate(page, size)
        if (sort.isNullOrBlank()) return PageRequest.of(page, size, default)
        val parts = sort.split(",")
        val column =
            allowed[parts[0]] ?: throw ValidationException("sort field '${parts[0]}' is not allowed; allowed: ${allowed.keys.sorted()}")
        val direction =
            when (parts.getOrNull(1)?.lowercase()) {
                null, "asc" -> Sort.Direction.ASC
                "desc" -> Sort.Direction.DESC
                else -> throw ValidationException("sort direction must be asc or desc")
            }
        return PageRequest.of(page, size, Sort.by(direction, column).and(Sort.by(Sort.Direction.DESC, "id")))
    }
}

/** Bounded, validated time range for analytics-style queries. */
data class TimeRange(
    val from: Instant,
    val to: Instant,
) {
    companion object {
        fun resolve(
            from: Instant?,
            to: Instant?,
            now: Instant,
            default: Duration,
            max: Duration,
        ): TimeRange {
            val end = to ?: now
            val start = from ?: end.minus(default)
            if (!start.isBefore(end)) throw ValidationException("'from' must be before 'to'")
            if (Duration.between(start, end) > max) {
                throw ValidationException("time window exceeds the maximum of ${max.toDays()} days")
            }
            return TimeRange(start, end)
        }
    }
}
