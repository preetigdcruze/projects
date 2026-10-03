package com.paysense.payments

import com.paysense.common.ConflictException

enum class PaymentStatus {
    CREATED,
    PROCESSING, // authorization in flight
    AUTHORIZED,
    CAPTURING, // capture in flight
    CAPTURED,
    REFUNDING, // refund in flight
    REFUNDED,
    FAILED,
    CANCELLED,

    /** The processor call may or may not have taken effect (e.g. timeout). Resolved by lookup/callback, never blind retry. */
    UNCERTAIN,
    ;

    val isTerminal: Boolean get() = this == FAILED || this == CANCELLED || this == REFUNDED
    val isInFlight: Boolean get() = this == PROCESSING || this == CAPTURING || this == REFUNDING
}

enum class PaymentOperation(
    val inFlight: PaymentStatus,
    val startsFrom: PaymentStatus,
    val succeedsTo: PaymentStatus,
    val declinedTo: PaymentStatus,
) {
    AUTHORIZE(PaymentStatus.PROCESSING, PaymentStatus.CREATED, PaymentStatus.AUTHORIZED, PaymentStatus.FAILED),
    CAPTURE(PaymentStatus.CAPTURING, PaymentStatus.AUTHORIZED, PaymentStatus.CAPTURED, PaymentStatus.AUTHORIZED),
    REFUND(PaymentStatus.REFUNDING, PaymentStatus.CAPTURED, PaymentStatus.REFUNDED, PaymentStatus.CAPTURED),
    ;

    /** State the payment returns to when the operation provably did not happen. */
    val revertsTo: PaymentStatus get() = startsFrom
}

class InvalidTransitionException(
    val from: PaymentStatus,
    val to: PaymentStatus,
) : ConflictException("INVALID_STATE_TRANSITION", "A payment in state $from cannot move to $to")

/** The one place that defines which payment state changes are legal. */
object PaymentStateMachine {
    private val transitions: Map<PaymentStatus, Set<PaymentStatus>> =
        mapOf(
            PaymentStatus.CREATED to setOf(PaymentStatus.PROCESSING, PaymentStatus.CANCELLED),
            // PROCESSING -> CREATED: the processor was provably never reached, so the client may safely authorize again
            PaymentStatus.PROCESSING to
                setOf(PaymentStatus.AUTHORIZED, PaymentStatus.FAILED, PaymentStatus.UNCERTAIN, PaymentStatus.CREATED),
            PaymentStatus.AUTHORIZED to setOf(PaymentStatus.CAPTURING, PaymentStatus.CANCELLED),
            PaymentStatus.CAPTURING to setOf(PaymentStatus.CAPTURED, PaymentStatus.AUTHORIZED, PaymentStatus.UNCERTAIN),
            PaymentStatus.CAPTURED to setOf(PaymentStatus.REFUNDING),
            PaymentStatus.REFUNDING to setOf(PaymentStatus.REFUNDED, PaymentStatus.CAPTURED, PaymentStatus.UNCERTAIN),
            PaymentStatus.UNCERTAIN to
                setOf(
                    PaymentStatus.AUTHORIZED,
                    PaymentStatus.FAILED,
                    PaymentStatus.CREATED, // pending AUTHORIZE
                    PaymentStatus.CAPTURED, // pending CAPTURE (AUTHORIZED again if not executed)
                    PaymentStatus.REFUNDED, // pending REFUND (CAPTURED again if not executed)
                ),
            PaymentStatus.FAILED to emptySet(),
            PaymentStatus.CANCELLED to emptySet(),
            PaymentStatus.REFUNDED to emptySet(),
        )

    fun allowedFrom(from: PaymentStatus): Set<PaymentStatus> = transitions.getValue(from)

    fun canTransition(
        from: PaymentStatus,
        to: PaymentStatus,
    ) = to in allowedFrom(from)

    fun require(
        from: PaymentStatus,
        to: PaymentStatus,
    ) {
        if (!canTransition(from, to)) throw InvalidTransitionException(from, to)
    }

    /** Where an UNCERTAIN payment may go once the pending [operation] is resolved. */
    fun resolutionTargets(operation: PaymentOperation): Set<PaymentStatus> =
        setOf(operation.succeedsTo, operation.declinedTo, operation.revertsTo)
}
