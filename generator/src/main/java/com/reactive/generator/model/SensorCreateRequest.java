package com.reactive.generator.model;

import java.time.Duration;

public record SensorCreateRequest(
        String name,
        SensorType type,
        String deviceId,
        Duration period
) { }
