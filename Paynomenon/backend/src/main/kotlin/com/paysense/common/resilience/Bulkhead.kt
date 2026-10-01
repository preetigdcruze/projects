package com.paysense.common.resilience

import java.time.Duration
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit

class BulkheadFullException(
    name: String,
) : RuntimeException("Bulkhead '$name' is at capacity; call rejected")

/** Bounds the number of concurrent calls into a dependency so a slow dependency cannot exhaust all threads. */
class Bulkhead(
    private val name: String,
    maxConcurrent: Int,
    private val maxWait: Duration = Duration.ofMillis(200),
) {
    private val permits = Semaphore(maxConcurrent, true)

    fun <T> run(block: () -> T): T {
        if (!permits.tryAcquire(maxWait.toMillis(), TimeUnit.MILLISECONDS)) throw BulkheadFullException(name)
        try {
            return block()
        } finally {
            permits.release()
        }
    }

    fun available(): Int = permits.availablePermits()
}
