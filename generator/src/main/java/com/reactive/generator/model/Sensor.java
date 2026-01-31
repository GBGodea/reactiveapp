package com.reactive.generator.model;

import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Duration;

@Document("sensors")
public record Sensor(
        @Id String id,
        String name,
        SensorType type,
        String deviceId,
        Duration period,
        boolean enabled
) {
}