package com.paysense.common

import jakarta.servlet.http.HttpServletRequest
import org.slf4j.LoggerFactory
import org.springframework.dao.DataAccessException
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.http.converter.HttpMessageNotReadableException
import org.springframework.security.access.AccessDeniedException
import org.springframework.transaction.CannotCreateTransactionException
import org.springframework.transaction.TransactionTimedOutException
import org.springframework.web.HttpMediaTypeNotSupportedException
import org.springframework.web.HttpRequestMethodNotSupportedException
import org.springframework.web.bind.MethodArgumentNotValidException
import org.springframework.web.bind.MissingRequestHeaderException
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.RestControllerAdvice
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException
import org.springframework.web.servlet.resource.NoResourceFoundException
import java.time.Instant

/** Consistent error body for every non-2xx response. Never carries stack traces or internal messages. */
data class ErrorResponse(
    val code: String,
    val message: String,
    val status: Int,
    val timestamp: Instant,
    val path: String?,
    val correlationId: String?,
    val details: List<FieldIssue> = emptyList(),
)

data class FieldIssue(
    val field: String,
    val message: String,
)

open class ApiException(
    val status: HttpStatus,
    val code: String,
    override val message: String,
    val details: List<FieldIssue> = emptyList(),
    val headers: Map<String, String> = emptyMap(),
) : RuntimeException(message)

class ValidationException(
    message: String,
    details: List<FieldIssue> = emptyList(),
) : ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", message, details)

class NotFoundException(
    what: String,
    id: Any,
) : ApiException(HttpStatus.NOT_FOUND, "NOT_FOUND", "$what '$id' was not found")

open class ConflictException(
    code: String,
    message: String,
    headers: Map<String, String> = emptyMap(),
) : ApiException(HttpStatus.CONFLICT, code, message, headers = headers)

class UnprocessableException(
    code: String,
    message: String,
) : ApiException(HttpStatus.UNPROCESSABLE_ENTITY, code, message)

class TooManyRequestsException(
    retryAfterSeconds: Long,
) : ApiException(
    HttpStatus.TOO_MANY_REQUESTS,
    "RATE_LIMITED",
    "Too many requests; retry later",
    headers = mapOf(HttpHeaders.RETRY_AFTER to retryAfterSeconds.toString()),
)

class ServiceUnavailableException(
    code: String,
    message: String,
    retryAfterSeconds: Long = 5,
) : ApiException(
    HttpStatus.SERVICE_UNAVAILABLE,
    code,
    message,
    headers = mapOf(HttpHeaders.RETRY_AFTER to retryAfterSeconds.toString()),
)

@RestControllerAdvice
class GlobalExceptionHandler {
    private val log = LoggerFactory.getLogger(javaClass)

    @ExceptionHandler(ApiException::class)
    fun api(
        e: ApiException,
        req: HttpServletRequest,
    ) = respond(e.status, e.code, e.message, req, e.details, e.headers)

    @ExceptionHandler(MethodArgumentNotValidException::class)
    fun invalid(
        e: MethodArgumentNotValidException,
        req: HttpServletRequest,
    ) = respond(
        HttpStatus.BAD_REQUEST,
        "VALIDATION_FAILED",
        "Request validation failed",
        req,
        e.bindingResult.fieldErrors.map { FieldIssue(it.field, it.defaultMessage ?: "invalid") },
    )

    @ExceptionHandler(HttpMessageNotReadableException::class)
    fun unreadable(
        e: HttpMessageNotReadableException,
        req: HttpServletRequest,
    ) = respond(HttpStatus.BAD_REQUEST, "MALFORMED_REQUEST", "Request body is missing or malformed JSON", req)

    @ExceptionHandler(MethodArgumentTypeMismatchException::class)
    fun typeMismatch(
        e: MethodArgumentTypeMismatchException,
        req: HttpServletRequest,
    ) = respond(HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", "Parameter '${e.name}' has an invalid value", req)

    @ExceptionHandler(MissingRequestHeaderException::class)
    fun missingHeader(
        e: MissingRequestHeaderException,
        req: HttpServletRequest,
    ) = respond(HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", "Header '${e.headerName}' is required", req)

    @ExceptionHandler(HttpRequestMethodNotSupportedException::class)
    fun method(
        e: HttpRequestMethodNotSupportedException,
        req: HttpServletRequest,
    ) = respond(HttpStatus.METHOD_NOT_ALLOWED, "METHOD_NOT_ALLOWED", "Method not allowed", req)

    @ExceptionHandler(HttpMediaTypeNotSupportedException::class)
    fun media(
        e: HttpMediaTypeNotSupportedException,
        req: HttpServletRequest,
    ) = respond(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UNSUPPORTED_MEDIA_TYPE", "Unsupported media type", req)

    @ExceptionHandler(NoResourceFoundException::class)
    fun noResource(
        e: NoResourceFoundException,
        req: HttpServletRequest,
    ) = respond(HttpStatus.NOT_FOUND, "NOT_FOUND", "Resource not found", req)

    @ExceptionHandler(AccessDeniedException::class)
    fun denied(
        e: AccessDeniedException,
        req: HttpServletRequest,
    ) = respond(HttpStatus.FORBIDDEN, "FORBIDDEN", "You do not have permission to perform this action", req)

    /** Pool exhausted or database unreachable: a transaction could not even be started. Nothing was changed. */
    @ExceptionHandler(CannotCreateTransactionException::class, TransactionTimedOutException::class)
    fun cannotStartTransaction(
        e: Exception,
        req: HttpServletRequest,
    ): ResponseEntity<ErrorResponse> {
        log.error("Could not obtain a database transaction for {} {}: {}", req.method, req.requestURI, e.javaClass.simpleName)
        return respond(
            HttpStatus.SERVICE_UNAVAILABLE,
            "DATABASE_UNAVAILABLE",
            "The request could not be completed; no state was changed. Please retry.",
            req,
            headers = mapOf(HttpHeaders.RETRY_AFTER to "5"),
        )
    }

    @ExceptionHandler(DataAccessException::class)
    fun db(
        e: DataAccessException,
        req: HttpServletRequest,
    ): ResponseEntity<ErrorResponse> {
        log.error("Database error handling {} {}", req.method, req.requestURI, e)
        return respond(
            HttpStatus.SERVICE_UNAVAILABLE,
            "DATABASE_UNAVAILABLE",
            "The request could not be completed; no state was changed. Please retry.",
            req,
            headers = mapOf(HttpHeaders.RETRY_AFTER to "5"),
        )
    }

    @ExceptionHandler(Exception::class)
    fun unexpected(
        e: Exception,
        req: HttpServletRequest,
    ): ResponseEntity<ErrorResponse> {
        log.error("Unhandled error handling {} {}", req.method, req.requestURI, e)
        return respond(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", "An unexpected error occurred", req)
    }

    private fun respond(
        status: HttpStatus,
        code: String,
        message: String,
        req: HttpServletRequest,
        details: List<FieldIssue> = emptyList(),
        headers: Map<String, String> = emptyMap(),
    ): ResponseEntity<ErrorResponse> {
        val body = ErrorResponse(code, message, status.value(), Instant.now(), req.requestURI, CorrelationId.current(), details)
        val builder = ResponseEntity.status(status)
        headers.forEach { (k, v) -> builder.header(k, v) }
        return builder.body(body)
    }
}
