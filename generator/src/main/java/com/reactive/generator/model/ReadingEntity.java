package com.reactive.generator.model;

import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;

@Document("readings")
public record ReadingEntity(
        @Id String id,
        String sensorId,
        String deviceId,
        SensorType type,
        Instant ts,
        double value
) {}
