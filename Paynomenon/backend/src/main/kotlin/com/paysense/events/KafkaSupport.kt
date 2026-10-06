package com.paysense.events

import com.fasterxml.jackson.databind.ObjectMapper
import com.paysense.common.CorrelationId
import com.paysense.common.PaySenseProperties
import org.apache.kafka.clients.admin.Admin
import org.apache.kafka.clients.admin.OffsetSpec
import org.apache.kafka.clients.consumer.ConsumerRecord
import org.apache.kafka.common.TopicPartition
import org.slf4j.LoggerFactory
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.boot.autoconfigure.kafka.KafkaProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.kafka.annotation.KafkaListener
import org.springframework.kafka.config.ConcurrentKafkaListenerContainerFactory
import org.springframework.kafka.config.TopicBuilder
import org.springframework.kafka.core.ConsumerFactory
import org.springframework.kafka.listener.ContainerProperties
import org.springframework.kafka.listener.DefaultErrorHandler
import org.springframework.kafka.support.Acknowledgment
import org.springframework.stereotype.Component
import org.springframework.util.backoff.FixedBackOff
import java.util.concurrent.TimeUnit

@Configuration
@ConditionalOnProperty("paysense.events.transport", havingValue = "kafka")
class KafkaConfig(
    private val props: PaySenseProperties,
) {
    @Bean
    fun eventsTopic() =
        TopicBuilder
            .name(props.events.topic)
            .partitions(props.events.partitions)
            .replicas(1)
            .build()

    @Bean
    fun kafkaListenerContainerFactory(
        consumerFactory: ConsumerFactory<String, String>,
    ): ConcurrentKafkaListenerContainerFactory<String, String> =
        ConcurrentKafkaListenerContainerFactory<String, String>().apply {
            setConsumerFactory(consumerFactory)
            setConcurrency(props.events.partitions)
            containerProperties.ackMode = ContainerProperties.AckMode.MANUAL_IMMEDIATE
            // Infrastructure failure (e.g. database down while dead-lettering): never skip the record; redeliver forever.
            setCommonErrorHandler(DefaultErrorHandler(FixedBackOff(2000L, FixedBackOff.UNLIMITED_ATTEMPTS)))
        }
}

/**
 * Kafka entry point. The offset is committed only after the dispatcher returned, i.e. after every handler processed
 * the event or it was durably dead-lettered. A crash before the commit leads to redelivery; dedupe makes it harmless.
 */
@Component
@ConditionalOnProperty("paysense.events.transport", havingValue = "kafka")
class EventListener(
    private val dispatcher: EventDispatcher,
    private val mapper: ObjectMapper,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    @KafkaListener(topics = ["\${paysense.events.topic}"], groupId = "\${paysense.events.consumer-group}")
    fun onMessage(
        record: ConsumerRecord<String, String>,
        ack: Acknowledgment,
    ) {
        val envelope =
            try {
                mapper.readValue(record.value(), EventEnvelope::class.java)
            } catch (e: Exception) {
                log.error("Unparseable event at {}-{}@{}; dead-lettering", record.topic(), record.partition(), record.offset())
                dispatcher.deadLetter("deserializer", null, record.value() ?: "", e, 1, record.partition(), record.offset())
                ack.acknowledge()
                return
            }
        CorrelationId.with(envelope.correlationId) {
            dispatcher.dispatch(envelope, record.value(), record.partition(), record.offset())
        }
        ack.acknowledge()
    }
}

data class ConsumerLag(
    val totalLag: Long,
    val partitions: Int,
)

/** Reads committed offsets vs. log-end offsets for the consumer group. Returns null if the broker is unreachable. */
@Component
class KafkaLagReader(
    private val kafkaProps: KafkaProperties,
    private val props: PaySenseProperties,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    fun read(): ConsumerLag? {
        if (!props.events.transport.equals("kafka", true)) return null
        return try {
            val cfg =
                kafkaProps.buildAdminProperties(null).toMutableMap().apply {
                    put("request.timeout.ms", 2000)
                    put("default.api.timeout.ms", 3000)
                }
            Admin.create(cfg).use { admin ->
                val topic = props.events.topic
                val partitions =
                    admin
                        .describeTopics(listOf(topic))
                        .allTopicNames()
                        .get(3, TimeUnit.SECONDS)
                        .getValue(topic)
                        .partitions()
                        .map { TopicPartition(topic, it.partition()) }
                val committed =
                    admin
                        .listConsumerGroupOffsets(
                            props.events.consumerGroup,
                        ).partitionsToOffsetAndMetadata()
                        .get(3, TimeUnit.SECONDS)
                val ends =
                    admin
                        .listOffsets(
                            partitions.associateWith<TopicPartition, OffsetSpec> { OffsetSpec.latest() },
                        ).all()
                        .get(3, TimeUnit.SECONDS)
                val begins =
                    admin
                        .listOffsets(
                            partitions.associateWith<TopicPartition, OffsetSpec> {
                                OffsetSpec.earliest()
                            },
                        ).all()
                        .get(3, TimeUnit.SECONDS)
                // a partition without a committed offset has everything since its first retained record still to consume
                val lag =
                    partitions.sumOf { tp ->
                        (ends.getValue(tp).offset() - (committed[tp]?.offset() ?: begins.getValue(tp).offset())).coerceAtLeast(0)
                    }
                ConsumerLag(lag, partitions.size)
            }
        } catch (e: Exception) {
            log.debug("Kafka lag unavailable: {}", e.javaClass.simpleName)
            null
        }
    }
}
