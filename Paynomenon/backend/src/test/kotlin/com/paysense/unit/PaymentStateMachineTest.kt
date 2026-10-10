package com.paysense.unit

import com.paysense.payments.InvalidTransitionException
import com.paysense.payments.Payment
import com.paysense.payments.PaymentOperation
import com.paysense.payments.PaymentStateMachine
import com.paysense.payments.PaymentStatus
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.EnumSource
import java.time.Instant
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PaymentStateMachineTest {
    @Test
    fun `happy path is legal`() {
        val path =
            listOf(
                PaymentStatus.CREATED,
                PaymentStatus.PROCESSING,
                PaymentStatus.AUTHORIZED,
                PaymentStatus.CAPTURING,
                PaymentStatus.CAPTURED,
                PaymentStatus.REFUNDING,
                PaymentStatus.REFUNDED,
            )
        path.zipWithNext().forEach { (a, b) -> assertTrue(PaymentStateMachine.canTransition(a, b), "$a -> $b") }
    }

    @ParameterizedTest
    @EnumSource(value = PaymentStatus::class, names = ["FAILED", "CANCELLED", "REFUNDED"])
    fun `terminal states allow no transition at all`(terminal: PaymentStatus) {
        assertTrue(terminal.isTerminal)
        PaymentStatus.entries.forEach { assertFalse(PaymentStateMachine.canTransition(terminal, it), "$terminal -> $it") }
    }

    @Test
    fun `illegal jumps are rejected with a clear error`() {
        val e = assertThrows<InvalidTransitionException> { PaymentStateMachine.require(PaymentStatus.CREATED, PaymentStatus.CAPTURED) }
        assertEquals("INVALID_STATE_TRANSITION", e.code)
        assertTrue(e.message.contains("CREATED") && e.message.contains("CAPTURED"))
        assertFalse(PaymentStateMachine.canTransition(PaymentStatus.AUTHORIZED, PaymentStatus.REFUNDED), "refund needs a capture first")
        assertFalse(PaymentStateMachine.canTransition(PaymentStatus.CAPTURED, PaymentStatus.AUTHORIZED))
    }

    @Test
    fun `entity transitions cannot bypass the state machine`() {
        val p = Payment(status = PaymentStatus.CREATED)
        assertThrows<InvalidTransitionException> { p.transitionTo(PaymentStatus.CAPTURED, Instant.now()) }
        assertEquals(PaymentStatus.CREATED, p.status)
        p.transitionTo(PaymentStatus.PROCESSING, Instant.EPOCH)
        assertEquals(PaymentStatus.PROCESSING, p.status)
    }

    @ParameterizedTest
    @EnumSource(PaymentOperation::class)
    fun `every operation can resolve an uncertain outcome in each direction`(op: PaymentOperation) {
        // the states an operation can end in must all be reachable from UNCERTAIN, otherwise reconciliation could get stuck
        PaymentStateMachine.resolutionTargets(op).forEach { target ->
            assertTrue(PaymentStateMachine.canTransition(PaymentStatus.UNCERTAIN, target), "UNCERTAIN -> $target for $op")
        }
        assertTrue(PaymentStateMachine.canTransition(op.inFlight, PaymentStatus.UNCERTAIN))
        assertTrue(PaymentStateMachine.canTransition(op.startsFrom, op.inFlight))
        assertTrue(PaymentStateMachine.canTransition(op.inFlight, op.succeedsTo))
    }

    @Test
    fun `in-flight states are exactly the three operation states`() {
        assertEquals(
            setOf(PaymentStatus.PROCESSING, PaymentStatus.CAPTURING, PaymentStatus.REFUNDING),
            PaymentStatus.entries
                .filter {
                    it.isInFlight
                }.toSet(),
        )
    }
}
