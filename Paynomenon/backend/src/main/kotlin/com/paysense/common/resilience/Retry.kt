package com.paysense.common.resilience

import java.time.Duration
import java.util.concurrent.ThreadLocalRandom
import kotlin.math.min
import kotlin.math.pow

/** How a failure should be treated by the retry machinery. */
enum class Retryability {
    /** Safe to repeat: the operation provably did not take effect, or it is idempotent. */
    RETRYABLE,

    /** Repeating cannot help (validation errors, declines, programming errors). */
    NON_RETRYABLE,

    /** The operation may or may not have taken effect. Never repeat blindly; reconcile instead. */
    AMBIGUOUS,
}

fun interface ErrorClassifier {
    fun classify(error: Throwable): Retryability
}

data class RetryPolicy(
    val maxAttempts: Int,
    val initialBackoff: Duration,
    val maxBackoff: Duration,
    val multiplier: Double = 2.0,
    val maxElapsed: Duration,
) {
    init {
        require(maxAttempts >= 1) { "maxAttempts must be >= 1" }
        require(multiplier >= 1.0) { "multiplier must be >= 1" }
    }

    /** Upper bound of the delay before attempt [attempt]+1 (attempt is 1-based). */
    fun ceilingFor(attempt: Int): Duration {
        val millis = initialBackoff.toMillis() * multiplier.pow(attempt - 1)
        return Duration.ofMillis(min(millis, maxBackoff.toMillis().toDouble()).toLong())
    }

    /** Exponential backoff with "equal jitter": half deterministic, half random, to avoid synchronized retries. */
    fun delayFor(
        attempt: Int,
        random: () -> Double = { ThreadLocalRandom.current().nextDouble() },
    ): Duration {
        val ceiling = ceilingFor(attempt).toMillis()
        val half = ceiling / 2
        return Duration.ofMillis(half + (random() * (ceiling - half)).toLong())
    }
}

fun interface Sleeper {
    fun sleep(duration: Duration)

    companion object {
        val THREAD = Sleeper { if (!it.isZero && !it.isNegative) Thread.sleep(it.toMillis()) }
    }
}

class RetryExhaustedException(
    val attempts: Int,
    cause: Throwable,
) : RuntimeException("Gave up after $attempts attempt(s): ${cause.javaClass.simpleName}", cause)

/** Observer hook so callers can count retries without this class depending on the metrics library. */
fun interface RetryListener {
    fun onRetry(
        attempt: Int,
        error: Throwable,
        delay: Duration,
    )
}

class RetryExecutor(
    private val sleeper: Sleeper = Sleeper.THREAD,
    private val nanoTime: () -> Long = System::nanoTime,
    private val random: () -> Double = { ThreadLocalRandom.current().nextDouble() },
) {
    /**
     * Runs [block] up to policy.maxAttempts times within policy.maxElapsed. Only [Retryability.RETRYABLE] failures
     * are repeated; AMBIGUOUS and NON_RETRYABLE failures propagate unchanged on the first occurrence.
     * When retries are exhausted the last failure is thrown wrapped in [RetryExhaustedException].
     */
    fun <T> execute(
        policy: RetryPolicy,
        classifier: ErrorClassifier,
        listener: RetryListener? = null,
        block: (attempt: Int) -> T,
    ): T {
        val started = nanoTime()
        var attempt = 1
        while (true) {
            try {
                return block(attempt)
            } catch (e: Throwable) {
                if (classifier.classify(e) != Retryability.RETRYABLE) throw e
                val elapsed = Duration.ofNanos(nanoTime() - started)
                val delay = policy.delayFor(attempt, random)
                if (attempt >= policy.maxAttempts || elapsed + delay > policy.maxElapsed) {
                    throw RetryExhaustedException(attempt, e)
                }
                listener?.onRetry(attempt, e, delay)
                sleeper.sleep(delay)
                attempt++
            }
        }
    }
}
