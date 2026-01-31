package com.reactive.generator.model;

import java.time.Instant;

public record Reading(
        String sensorId,
        String deviceId,
        SensorType type,
        Instant ts,
        double value
) {
}
