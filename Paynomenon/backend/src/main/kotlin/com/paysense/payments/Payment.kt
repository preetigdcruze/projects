package com.paysense.payments

import com.paysense.common.Money
import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.EnumType
import jakarta.persistence.Enumerated
import jakarta.persistence.Id
import jakarta.persistence.LockModeType
import jakarta.persistence.Table
import jakarta.persistence.Version
import org.hibernate.annotations.JdbcTypeCode
import org.hibernate.type.SqlTypes
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.JpaSpecificationExecutor
import org.springframework.data.jpa.repository.Lock
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import java.math.BigDecimal
import java.time.Instant
import java.util.UUID

@Entity
@Table(name = "payments")
class Payment(
    @Id var id: UUID = UUID.randomUUID(),
    @Column(name = "merchant_id", nullable = false) var merchantId: String = "",
    @Column(nullable = false, precision = 19, scale = 4) var amount: BigDecimal = BigDecimal.ZERO,
    @JdbcTypeCode(SqlTypes.CHAR) @Column(nullable = false, length = 3) var currency: String = "",
    @Column(nullable = false) var processor: String = "",
    var description: String? = null,
    @Enumerated(EnumType.STRING) @Column(nullable = false) var status: PaymentStatus = PaymentStatus.CREATED,
    @Enumerated(EnumType.STRING) @Column(name = "pending_operation") var pendingOperation: PaymentOperation? = null,
    @Column(name = "failure_code") var failureCode: String? = null,
    @Column(name = "failure_category") var failureCategory: String? = null,
    @Column(name = "correlation_id", nullable = false) var correlationId: String = "",
    @Column(name = "created_by", nullable = false) var createdBy: String = "",
    @Column(nullable = false) var synthetic: Boolean = false,
    @Version @Column(nullable = false) var version: Long = 0,
    @Column(name = "created_at", nullable = false) var createdAt: Instant = Instant.EPOCH,
    @Column(name = "updated_at", nullable = false) var updatedAt: Instant = Instant.EPOCH,
    @Column(name = "authorized_at") var authorizedAt: Instant? = null,
    @Column(name = "captured_at") var capturedAt: Instant? = null,
    @Column(name = "refunded_at") var refundedAt: Instant? = null,
    @Column(name = "failed_at") var failedAt: Instant? = null,
) {
    fun money(): Money = Money.fromStorage(amount, currency)

    /** All status changes go through here so the state machine cannot be bypassed. */
    fun transitionTo(
        to: PaymentStatus,
        now: Instant,
    ) {
        PaymentStateMachine.require(status, to)
        status = to
        updatedAt = now
    }
}

interface PaymentRepository :
    JpaRepository<Payment, UUID>,
    JpaSpecificationExecutor<Payment> {
    /** Row lock that serializes all mutations of one payment. */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select p from Payment p where p.id = :id")
    fun lockById(
        @Param("id") id: UUID,
    ): Payment?
}
