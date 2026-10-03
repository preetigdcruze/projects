package com.paysense.processors

import com.paysense.common.PaySenseProperties
import com.paysense.common.resilience.Bulkhead
import com.paysense.common.resilience.BulkheadFullException
import com.paysense.common.resilience.CircuitBreaker
import com.paysense.common.resilience.CircuitBreakerConfig
import com.paysense.common.resilience.CircuitOpenException
import com.paysense.common.resilience.CircuitState
import com.paysense.common.resilience.ErrorClassifier
import com.paysense.common.resilience.RetryExecutor
import com.paysense.common.resilience.RetryExhaustedException
import com.paysense.common.resilience.RetryListener
import com.paysense.common.resilience.RetryPolicy
import com.paysense.common.resilience.Retryability
import com.paysense.observability.OperationalLogService
import com.paysense.observability.PaySenseMetrics
import org.springframework.stereotype.Component
import java.time.Clock
import java.time.Duration
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/** Processor call rejected locally (open circuit or full bulkhead). Nothing was sent: safe to retry later. */
class ProcessorRejectedException(
    val reason: String,
    message: String,
) : ProcessorUnavailableException(message, "PROCESSOR_REJECTED_$reason")

object ProcessorErrorClassifier : ErrorClassifier {
    override fun classify(error: Throwable) =
        when (error) {
            is ProcessorTimeoutException -> Retryability.AMBIGUOUS
            is ProcessorRejectedException -> Retryability.NON_RETRYABLE
            is ProcessorUnavailableException -> Retryability.RETRYABLE
            else -> Retryability.NON_RETRYABLE
        }
}

/**
 * All processor traffic goes through here: bounded concurrency, per-call deadline, circuit breaker per processor and
 * retry with jittered backoff for failures that are provably safe to repeat. Timeouts are AMBIGUOUS and surface as
 * [ProcessorTimeoutException]; they are never retried here.
 */
@Component
class ResilientProcessorClient(
    private val registry: ProcessorRegistry,
    private val props: PaySenseProperties,
    private val metrics: PaySenseMetrics,
    private val opLog: OperationalLogService,
    private val clock: Clock,
) {
    private val cfg = props.processors
    private val retryExecutor = RetryExecutor()
    private val policy =
        RetryPolicy(cfg.retry.maxAttempts, cfg.retry.initialBackoff, cfg.retry.maxBackoff, cfg.retry.multiplier, cfg.retry.maxElapsed)
    private val bulkhead = Bulkhead("processor-calls", cfg.maxConcurrentCalls)
    private val executor = Executors.newVirtualThreadPerTaskExecutor()
    private val breakers = ConcurrentHashMap<String, CircuitBreaker>()

    fun circuitState(processor: String): CircuitState = breaker(processor).state()

    fun circuitStates(): Map<String, CircuitState> = registry.names.associateWith { circuitState(it) }

    /** Drops all breaker state. Only used by the development seeder and by tests. */
    fun resetCircuits() {
        breakers.clear()
        registry.names.forEach { metrics.circuitState(it, CircuitState.CLOSED) }
    }

    fun execute(
        request: ProcessorRequest,
        deadline: Duration = cfg.callTimeout,
    ): ProcessorResponse {
        val processor = registry.require(request.processor)
        val breaker = breaker(request.processor)
        val started = System.nanoTime()
        try {
            val response =
                try {
                    retryExecutor.execute(policy, ProcessorErrorClassifier, retryListener(request)) { _ ->
                        guardedCall(breaker, request.processor) { callWithDeadline(request, processor, deadline) }
                    }
                } catch (e: RetryExhaustedException) {
                    throw ProcessorUnavailableException(
                        "${request.processor} stayed unavailable after ${e.attempts} attempts",
                        "PROCESSOR_UNAVAILABLE",
                    )
                }
            metrics.processorLatency(request.processor, request.operation.name, response.latencyMs.toLong())
            return response
        } catch (e: ProcessorTimeoutException) {
            metrics.processorLatency(request.processor, request.operation.name, Duration.ofNanos(System.nanoTime() - started).toMillis())
            throw e
        }
    }

    fun lookup(
        processorName: String,
        requestId: String,
    ): LookupResult {
        val processor = registry.require(processorName)
        val breaker = breaker(processorName)
        return try {
            retryExecutor.execute(policy, ProcessorErrorClassifier) { _ ->
                guardedCall(breaker, processorName) { processor.lookup(requestId) }
            }
        } catch (e: RetryExhaustedException) {
            throw ProcessorUnavailableException("$processorName lookup failed after ${e.attempts} attempts")
        }
    }

    private fun <T> guardedCall(
        breaker: CircuitBreaker,
        processorName: String,
        call: () -> T,
    ): T {
        try {
            breaker.acquire()
        } catch (e: CircuitOpenException) {
            metrics.processorRejected(processorName, "circuit_open")
            throw ProcessorRejectedException("CIRCUIT_OPEN", "Circuit for $processorName is open; retry after ${e.retryAfter.seconds}s")
        }
        try {
            val result =
                try {
                    bulkhead.run(call)
                } catch (e: BulkheadFullException) {
                    breaker.success() // not the processor's fault; releases a half-open probe without penalty
                    metrics.processorRejected(processorName, "bulkhead_full")
                    throw ProcessorRejectedException("BULKHEAD_FULL", "Too many concurrent processor calls")
                }
            breaker.success()
            return result
        } catch (e: ProcessorRejectedException) {
            throw e
        } catch (e: ProcessorTimeoutException) {
            breaker.failure()
            throw e
        } catch (e: ProcessorUnavailableException) {
            breaker.failure()
            throw e
        } catch (e: RuntimeException) {
            breaker.failure()
            throw e
        }
    }

    private fun callWithDeadline(
        request: ProcessorRequest,
        processor: PaymentProcessor,
        deadline: Duration,
    ): ProcessorResponse {
        val future = executor.submit<ProcessorResponse> { processor.execute(request) }
        try {
            return future.get(deadline.toMillis(), TimeUnit.MILLISECONDS)
        } catch (e: TimeoutException) {
            future.cancel(true)
            throw ProcessorTimeoutException(request.requestId, deadline.toMillis())
        } catch (e: ExecutionException) {
            when (val cause = e.cause) {
                is ProcessorTimeoutExceptionInternal -> throw ProcessorTimeoutException(request.requestId, deadline.toMillis())
                is ProcessorUnavailableException -> throw cause
                is RuntimeException -> throw cause
                else -> throw IllegalStateException("processor call failed", cause)
            }
        } catch (e: InterruptedException) {
            future.cancel(true)
            Thread.currentThread().interrupt()
            throw e
        }
    }

    private fun retryListener(request: ProcessorRequest) =
        RetryListener { attempt, error, delay ->
            metrics.processorRetry(request.processor)
            opLog.record(
                "WARN",
                "processor-client",
                "Retrying ${request.operation} on ${request.processor} after attempt $attempt failed (${error.message}); next attempt in ${delay.toMillis()}ms",
                request.correlationId,
                request.paymentReference,
                mapOf("processor" to request.processor, "attempt" to attempt, "requestId" to request.requestId),
            )
        }

    private fun breaker(processor: String): CircuitBreaker =
        breakers.computeIfAbsent(processor) { name ->
            val c = cfg.circuitBreaker
            CircuitBreaker(
                name,
                CircuitBreakerConfig(c.windowSize, c.minCalls, c.failureRateThreshold, c.openDuration, c.halfOpenCalls),
                Clock.systemUTC(),
            ) { from, to ->
                metrics.circuitTransition(name, to)
                metrics.circuitState(name, to)
                opLog.record(
                    "WARN",
                    "circuit-breaker",
                    "Circuit for $name moved from $from to $to",
                    attributes =
                    mapOf(
                        "processor" to name,
                        "state" to to.name,
                    ),
                )
            }.also { metrics.circuitState(name, CircuitState.CLOSED) }
        }
}
