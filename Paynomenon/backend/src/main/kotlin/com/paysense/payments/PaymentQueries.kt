package com.paysense.payments

import com.paysense.common.NotFoundException
import com.paysense.common.PageResponse
import com.paysense.common.Paging
import com.paysense.common.ValidationException
import jakarta.persistence.criteria.Predicate
import org.springframework.data.domain.Sort
import org.springframework.data.jpa.domain.Specification
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Instant
import java.util.UUID

data class PaymentFilter(
    val status: PaymentStatus? = null,
    val processor: String? = null,
    val currency: String? = null,
    val merchantId: String? = null,
    val from: Instant? = null,
    val to: Instant? = null,
    val query: String? = null,
)

@Service
@Transactional(readOnly = true)
class PaymentQueryService(
    private val payments: PaymentRepository,
    private val events: PaymentEventRepository,
    private val attempts: PaymentAttemptRepository,
) {
    private val sortable = mapOf("createdAt" to "createdAt", "updatedAt" to "updatedAt", "amount" to "amount", "status" to "status")

    fun list(
        filter: PaymentFilter,
        page: Int,
        size: Int,
        sort: String?,
    ): PageResponse<PaymentResponse> {
        val pageable =
            Paging.pageRequest(
                page,
                size,
                sort,
                sortable,
                Sort.by(Sort.Direction.DESC, "createdAt").and(Sort.by(Sort.Direction.DESC, "id")),
            )
        if (filter.from != null && filter.to != null &&
            !filter.from.isBefore(filter.to)
        ) {
            throw ValidationException("'from' must be before 'to'")
        }
        val result = payments.findAll(spec(filter), pageable)
        return PageResponse.of(result) { PaymentResponse.from(it) }
    }

    fun get(id: UUID): PaymentResponse {
        val p = payments.findById(id).orElseThrow { NotFoundException("Payment", id) }
        return PaymentResponse.from(p, attempts.forPayment(id))
    }

    fun events(
        id: UUID,
        page: Int,
        size: Int,
    ): PageResponse<PaymentEventResponse> {
        Paging.validate(page, size)
        if (!payments.existsById(id)) throw NotFoundException("Payment", id)
        val items =
            events.page(id, page * size, size).map {
                PaymentEventResponse(
                    it.id,
                    it.sequence,
                    it.eventType,
                    it.fromStatus,
                    it.toStatus,
                    it.source,
                    it.actor,
                    it.correlationId,
                    it.metadata,
                    it.occurredAt,
                )
            }
        return PageResponse.of(items, page, size, events.count(id))
    }

    private fun spec(f: PaymentFilter) =
        Specification<Payment> { root, _, cb ->
            val preds = mutableListOf<Predicate>()
            f.status?.let { preds += cb.equal(root.get<PaymentStatus>("status"), it) }
            f.processor?.let { preds += cb.equal(root.get<String>("processor"), it) }
            f.currency?.let { preds += cb.equal(root.get<String>("currency"), it.uppercase()) }
            f.merchantId?.let { preds += cb.equal(root.get<String>("merchantId"), it) }
            f.from?.let { preds += cb.greaterThanOrEqualTo(root.get("createdAt"), it) }
            f.to?.let { preds += cb.lessThan(root.get("createdAt"), it) }
            f.query?.trim()?.takeIf { it.isNotEmpty() }?.let { q ->
                val asId = runCatching { UUID.fromString(q) }.getOrNull()
                preds +=
                    if (asId != null) {
                        cb.or(cb.equal(root.get<UUID>("id"), asId))
                    } else {
                        val like = "%" + q.lowercase().replace("%", "\\%").replace("_", "\\_") + "%"
                        cb.or(
                            cb.like(cb.lower(cb.coalesce(root.get<String>("description"), "")), like, '\\'),
                            cb.equal(root.get<String>("correlationId"), q),
                            cb.like(cb.lower(root.get("merchantId")), like, '\\'),
                        )
                    }
            }
            cb.and(*preds.toTypedArray())
        }
}
